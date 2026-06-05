import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { notifyOrderStatus } from '@/lib/orders/notify';
import { redeemRewardForOrder } from '@/lib/orders/rewards';
import { sendDeliverySurvey } from '@/lib/orders/survey';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ORDER_STATUSES = ['nuevo', 'pagado', 'cocina', 'empacado', 'ruta', 'entregado'] as const;
type OrderStatus = (typeof ORDER_STATUSES)[number];

const bodySchema = z.object({
  status: z.enum(ORDER_STATUSES),
});

/**
 * PATCH /api/orders/:id/status
 *
 * Reglas:
 * - Permite cualquier transición (avance o reverso) entre estados válidos.
 *   El reverso existe para cuando una operaria mueve un pedido por error.
 * - Side effect: en la PRIMERA transición a un estado notificable
 *   (pagado/cocina/ruta/entregado) se envía un WhatsApp de seguimiento al
 *   cliente. Es idempotente vía `orders.notified_statuses` (ver
 *   `@/lib/orders/notify`): un reverso + re-avance no reenvía.
 * - Si new_status === current_status, responde 200 noop sin tocar BD.
 *
 * Llamado por:
 * - Frontend (operario arrastra tarjeta en el kanban — en cualquier dirección)
 * - Wompi webhook (nuevo→pagado automático)
 */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const sb = supabaseAdmin();

  // 1. Obtener orden actual con nombre del customer (para el mensaje WhatsApp)
  const { data: order, error: getErr } = await sb
    .from('orders')
    .select('id, status, phone, notified_statuses, customer:customers(name)')
    .eq('id', id)
    .single();

  if (getErr || !order) {
    return Response.json({ ok: false, error: 'Pedido no encontrado' }, { status: 404 });
  }

  const currentStatus = order.status as OrderStatus;
  const newStatus = parsed.status;

  // 2. Noop si no cambia el estado (operario suelta la tarjeta en su misma columna)
  if (currentStatus === newStatus) {
    return Response.json({
      ok: true,
      orderId: id,
      from: currentStatus,
      to: newStatus,
      noop: true,
      notification: null,
    });
  }

  // 3. Aplicar cambio (cualquier dirección permitida)
  const { error: updErr } = await sb
    .from('orders')
    .update({ status: newStatus })
    .eq('id', id);

  if (updErr) {
    console.error('[orders/status] update error', updErr);
    return Response.json({ ok: false, error: updErr.message }, { status: 500 });
  }

  // (La asignación de cocinero al pasar a 'pagado' la hace el trigger de BD
  //  `assign_cook_on_paid` de la migración 0020, no este endpoint.)

  // 4. Side effect: notificación de seguimiento idempotente (pagado/cocina/
  //    ruta/entregado). No falla el endpoint si el envío falla: el estado ya
  //    cambió en BD.
  const result = await notifyOrderStatus({ sb, order, newStatus });
  const notification = result.sent
    ? { ok: true }
    : result.error
      ? { ok: false, error: result.error }
      : null;

  // 5. Post-venta (Tarea 3): al pagar, canjear (si hay) el cupón de postre
  //    vigente del cliente en este pedido. Idempotente por pedido.
  if (newStatus === 'pagado') {
    await redeemRewardForOrder({ sb, orderId: id, phone: (order as { phone: string }).phone });
  }

  // 6. Post-venta (Tarea 3): al entregar, enviar la encuesta de satisfacción
  //    JUSTO DESPUÉS del mensaje de "entregado" (síncrono, sin cron).
  //    `result.sent` garantiza que se manda una sola vez (la notificación de
  //    entregado ya es idempotente vía notified_statuses).
  if (newStatus === 'entregado' && result.sent) {
    await sendDeliverySurvey({ sb, orderId: id, phone: (order as { phone: string }).phone });
  }

  return Response.json({
    ok: true,
    orderId: id,
    from: currentStatus,
    to: newStatus,
    notification,
  });
}

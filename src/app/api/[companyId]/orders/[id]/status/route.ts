import { z } from 'zod';
import {
  isMarketplaceProvider,
  syncMarketplaceOrderStatus,
  type OrderStatus,
} from '@/lib/channels';
import { notifyOrderStatus } from '@/lib/orders/notify';
import { redeemRewardForOrder } from '@/lib/orders/rewards';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ORDER_STATUSES = ['nuevo', 'pagado', 'cocina', 'empacado', 'ruta', 'entregado'] as const;

const bodySchema = z.object({
  status: z.enum(ORDER_STATUSES),
});

/**
 * PATCH /api/<companyId>/orders/:id/status
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
 *
 * Aislamiento: `ctx.db` (RLS = capa 2) + `company_id` (capa 1) en cada query.
 */
export const PATCH = withTenant<{ companyId: string; id: string }>(async (request, ctx, params) => {
  const { id } = params;

  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const sb = ctx.db;
  const companyId = ctx.company.id;

  // 1. Obtener orden actual con nombre del customer (para el mensaje WhatsApp)
  const { data: order, error: getErr } = await sb
    .from('orders')
    .select('id, status, phone, notified_statuses, sales_channel, external_order_id, customer:customers(name)')
    .eq('company_id', companyId)
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

  // 3. Aplicar cambio (cualquier dirección permitida). Al ENTRAR a 'entregado'
  //    registramos `delivered_at` (hora de entrega): lo usan la encuesta diferida
  //    (cron survey-dispatch) y la reescritura post-venta (botones "otro pedido /
  //    humano" si el cliente escribe dentro de 1 h). Como el paso 2 ya descartó el
  //    noop, aquí `currentStatus !== newStatus`, así que esto se ejecuta al entrar
  //    a entregado (una reversa+reentrega rara de operario re-sella la hora, que
  //    es lo deseable: la encuesta es idempotente por `order_surveys`).
  const update: Record<string, unknown> = { status: newStatus };
  if (newStatus === 'entregado') {
    update.delivered_at = new Date().toISOString();
  }
  const { error: updErr } = await sb
    .from('orders')
    .update(update)
    .eq('company_id', companyId)
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
  const channelProvider = (order as { sales_channel?: string | null }).sales_channel ?? null;
  const externalOrderId = (order as { external_order_id?: string | null }).external_order_id ?? null;
  const marketplace = isMarketplaceProvider(channelProvider) ? channelProvider : null;

  const result = marketplace
    ? { sent: false as const, error: undefined }
    : await notifyOrderStatus({ sb, order, newStatus });
  const notification = marketplace
    ? { skipped: true, reason: 'marketplace_order' }
    : result.sent
      ? { ok: true }
      : result.error
        ? { ok: false, error: result.error }
        : null;

  const channelSync = marketplace
    ? await syncMarketplaceOrderStatus({
        sb,
        companyId,
        orderId: id,
        provider: marketplace,
        externalOrderId,
        fromStatus: currentStatus,
        toStatus: newStatus,
      })
    : null;

  // 5. Post-venta (Tarea 3): canjear (si hay) el cupón de postre vigente del
  //    cliente en este pedido apenas entra al kanban ('nuevo') o al pagar.
  //    Idempotente por pedido (no duplica si ya se canjeó al crearlo).
  if (newStatus === 'nuevo' || newStatus === 'pagado') {
    await redeemRewardForOrder({ sb, orderId: id, phone: (order as { phone: string }).phone, companyId });
  }

  // 6. Post-venta: la encuesta de satisfacción ya NO se manda acá. La difiere el
  //    cron `survey-dispatch` ~30 min después de la entrega
  //    (settings.survey_delay_minutes). El `delivered_at` del paso 3 le da al
  //    cron la hora de entrega para la ventana.

  return Response.json({
    ok: true,
    orderId: id,
    from: currentStatus,
    to: newStatus,
    notification,
    channelSync,
  });
});

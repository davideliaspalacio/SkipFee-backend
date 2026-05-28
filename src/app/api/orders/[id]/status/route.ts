import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { sendText } from '@/lib/kapso/client';
import { recordMessage } from '@/lib/messaging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ORDER_STATUSES = ['nuevo', 'pagado', 'cocina', 'empacado', 'ruta', 'entregado'] as const;
type OrderStatus = (typeof ORDER_STATUSES)[number];
const statusOrder: Record<OrderStatus, number> = {
  nuevo: 0,
  pagado: 1,
  cocina: 2,
  empacado: 3,
  ruta: 4,
  entregado: 5,
};

const bodySchema = z.object({
  status: z.enum(ORDER_STATUSES),
});

/**
 * PATCH /api/orders/:id/status
 *
 * Reglas:
 * - Solo avanza (no retrocede): si new_status <= current_status → 409
 * - Side effect: si transición es a 'ruta', enviar WhatsApp al cliente
 *   "Hola {name}, tu pedido va en camino 🛵"
 *
 * Llamado por:
 * - Frontend (operario arrastra tarjeta en el kanban)
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
    .select('id, status, phone, customer:customers(name)')
    .eq('id', id)
    .single();

  if (getErr || !order) {
    return Response.json({ ok: false, error: 'Pedido no encontrado' }, { status: 404 });
  }

  const currentStatus = order.status as OrderStatus;
  const newStatus = parsed.status;

  // 2. Validar transición (solo avance permitido)
  if (statusOrder[newStatus] <= statusOrder[currentStatus]) {
    return Response.json(
      {
        ok: false,
        error: `No se puede mover de "${currentStatus}" a "${newStatus}". Solo se permite avanzar.`,
      },
      { status: 409 },
    );
  }

  // 3. Aplicar cambio
  const { error: updErr } = await sb
    .from('orders')
    .update({ status: newStatus })
    .eq('id', id);

  if (updErr) {
    console.error('[orders/status] update error', updErr);
    return Response.json({ ok: false, error: updErr.message }, { status: 500 });
  }

  // 4. Side effect: si pasa a 'ruta', notificar al cliente
  let notificationSent: { ok: boolean; error?: string } | null = null;
  if (newStatus === 'ruta') {
    // Postgrest devuelve la relación como objeto o array según multiplicidad — normalizamos.
    const customerName = Array.isArray(order.customer)
      ? order.customer[0]?.name
      : (order.customer as { name?: string } | null)?.name;
    const firstName = (customerName ?? '').split(' ')[0] || '';
    const greeting = firstName ? `Hola ${firstName}` : 'Hola';
    const body = `${greeting}, tu pedido va en camino 🛵`;

    try {
      const result = await sendText(order.phone, body);
      const wamid = result.messages?.[0]?.id ?? null;
      await recordMessage({
        phone: order.phone,
        direction: 'out',
        body,
        kapsoMessageId: wamid,
      });
      notificationSent = { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[orders/status] notification error', err);
      notificationSent = { ok: false, error: msg };
      // No falla el endpoint — el estado ya cambió en BD.
    }
  }

  return Response.json({
    ok: true,
    orderId: id,
    from: currentStatus,
    to: newStatus,
    notification: notificationSent,
  });
}

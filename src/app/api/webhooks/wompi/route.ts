import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendText } from '@/lib/kapso/client';
import { recordMessage } from '@/lib/messaging';
import { verifyWebhookSignature } from '@/lib/wompi/signature';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/wompi  (público — lo llama Wompi)
 *
 * Webhook REAL para el Widget Checkout Web (CONTRACT_CHECKOUT.md + plan Wompi).
 * Convive con el mock legacy `/api/wompi/webhook` (form-urlencoded). El
 * frontend decide cuál usar según `WOMPI_MODE`.
 *
 * Defensa en profundidad — siempre antes de aplicar el cambio:
 *   1. Verificar firma SHA256 (X-Event-Checksum o signature.checksum del body)
 *   2. Idempotencia por `orders.wompi_tx_id` (Wompi reintenta hasta 3 veces en 24h)
 *   3. Revalidar `currency == 'COP'` y `amount_in_cents == orders.total * 100`
 *      (el monto puede haber cambiado entre que el cliente generó el widget y
 *      Wompi confirmó, si el carrito se editó)
 *   4. Solo aplicar si el estado actual es pagable (`borrador` o `pendiente_pago`)
 *
 * Transiciones:
 *   - APPROVED   ⇒ orders.status = 'pagado' + WhatsApp "pago recibido" + cierra flow_state
 *   - DECLINED/ERROR/VOIDED ⇒ orders.status = 'borrador' + guarda status_message
 *     (el cliente puede volver a la tienda y reintentar sin perder el carrito)
 *
 * Devuelve siempre 200 (excepto 400 JSON inválido, 401 firma inválida) para
 * que Wompi NO reintente errores de negocio. El campo `applied` indica si
 * efectivamente se mutó algo.
 */

const PAYABLE_STATUSES = ['borrador', 'pendiente_pago', 'nuevo'] as const;

interface WompiTransaction {
  id: string;
  amount_in_cents: number;
  reference: string;
  currency: string;
  payment_method_type: string;
  status: 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR';
  status_message: string | null;
}

interface WompiEvent {
  event: string;
  data: { transaction: WompiTransaction };
  timestamp: number;
  signature?: { properties?: string[]; checksum?: string };
}

interface OrderRow {
  id: string;
  status: string;
  phone: string;
  total: number;
  wompi_tx_id: string | null;
  customer: { name: string } | { name: string }[] | null;
}

export async function POST(request: NextRequest) {
  // 1. Parse JSON
  let event: WompiEvent;
  try {
    event = (await request.json()) as WompiEvent;
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  // 2. Verificar firma
  const headerChecksum = request.headers.get('x-event-checksum');
  if (!verifyWebhookSignature(event, headerChecksum)) {
    console.warn('[wompi webhook real] firma inválida', {
      event: event?.event,
      txId: event?.data?.transaction?.id,
    });
    return Response.json({ ok: false, error: 'invalid signature' }, { status: 401 });
  }

  // 3. Solo nos interesan transaction.updated
  if (event.event !== 'transaction.updated') {
    return Response.json({ ok: true, applied: false, reason: `event=${event.event} ignorado` });
  }

  const txn = event.data?.transaction;
  if (!txn?.id || !txn.reference) {
    return Response.json({ ok: true, applied: false, reason: 'transaction sin id/reference' });
  }

  const sb = supabaseAdmin();

  // 4. Cargar la orden por reference (== orderId)
  const { data: order } = (await sb
    .from('orders')
    .select('id, status, phone, total, wompi_tx_id, customer:customers(name)')
    .eq('id', txn.reference)
    .single()) as { data: OrderRow | null };

  if (!order) {
    console.warn('[wompi webhook real] orden no encontrada', { reference: txn.reference });
    return Response.json({ ok: true, applied: false, reason: 'orden no encontrada' });
  }

  // 5. Idempotencia: si ya tenemos este wompi_tx_id Y ya está en estado final, no re-procesar.
  //    (Wompi reintenta hasta 3 veces el mismo evento.)
  if (order.wompi_tx_id === txn.id && !(PAYABLE_STATUSES as readonly string[]).includes(order.status)) {
    return Response.json({ ok: true, applied: false, reason: 'idempotent: ya procesado' });
  }

  // 6. Validar currency
  if (txn.currency !== 'COP') {
    console.warn('[wompi webhook real] currency inesperada', { currency: txn.currency });
    return Response.json({
      ok: true,
      applied: false,
      reason: `currency ${txn.currency} != COP`,
    });
  }

  // 7. Estado pagable
  if (!(PAYABLE_STATUSES as readonly string[]).includes(order.status)) {
    return Response.json({
      ok: true,
      applied: false,
      reason: `status=${order.status}, esperaba ${PAYABLE_STATUSES.join(' o ')}`,
    });
  }

  // 8. Revalidación de monto (defensa contra manipulación / carrito modificado)
  const expectedCents = (order.total ?? 0) * 100;
  if (txn.amount_in_cents !== expectedCents) {
    console.warn('[wompi webhook real] monto no coincide', {
      orderId: order.id,
      amountWompi: txn.amount_in_cents,
      totalEsperado: expectedCents,
    });
    return Response.json({
      ok: true,
      applied: false,
      reason: `monto (${txn.amount_in_cents}) != total esperado (${expectedCents})`,
    });
  }

  // 9. Aplicar la transición según el status de la transacción.
  if (txn.status === 'APPROVED') {
    const { error: updErr } = await sb
      .from('orders')
      .update({
        status: 'pagado',
        wompi_tx_id: txn.id,
        wompi_status_message: null,
      })
      .eq('id', order.id);
    if (updErr) {
      console.error('[wompi webhook real] update pagado error', updErr);
      return Response.json({ ok: false, error: updErr.message }, { status: 500 });
    }
    console.log('[wompi webhook real] orden pagada', { orderId: order.id, txId: txn.id });

    // Side effects (mismo patrón que el webhook mock): no rompen la respuesta.
    try {
      const customer = Array.isArray(order.customer) ? order.customer[0] : order.customer;
      const firstName = (customer?.name ?? '').split(' ')[0] || '';
      const greeting = firstName ? `${firstName}, ` : '';
      const body =
        `¡${greeting}pago recibido! 🎉\n` +
        `Tu pedido ya pasa a cocina 🥪 Te aviso cuando vaya en camino.`;

      const result = await sendText(order.phone, body);
      const wamid = result.messages?.[0]?.id ?? null;
      await recordMessage({
        phone: order.phone,
        direction: 'bot',
        body,
        kapsoMessageId: wamid,
      });

      const chatId = `wa:${order.phone}`;
      await sb
        .from('chats')
        .update({
          flow_state: { step: 'finalizado', orderId: order.id },
          flow_updated_at: new Date().toISOString(),
        })
        .eq('id', chatId);
    } catch (err) {
      console.error('[wompi webhook real] notif error (orden ya pagada)', err);
    }

    return Response.json({
      ok: true,
      applied: true,
      orderId: order.id,
      newStatus: 'pagado',
    });
  }

  // DECLINED / VOIDED / ERROR: vuelve a borrador para que el cliente reintente.
  if (txn.status === 'DECLINED' || txn.status === 'VOIDED' || txn.status === 'ERROR') {
    const { error: updErr } = await sb
      .from('orders')
      .update({
        status: 'borrador',
        wompi_tx_id: txn.id,
        wompi_status_message: txn.status_message ?? `Pago ${txn.status.toLowerCase()}`,
      })
      .eq('id', order.id);
    if (updErr) {
      console.error('[wompi webhook real] update borrador error', updErr);
      return Response.json({ ok: false, error: updErr.message }, { status: 500 });
    }
    console.log('[wompi webhook real] pago no aprobado, orden vuelve a borrador', {
      orderId: order.id,
      txStatus: txn.status,
    });
    return Response.json({
      ok: true,
      applied: true,
      orderId: order.id,
      newStatus: 'borrador',
      txStatus: txn.status,
    });
  }

  // Otros status (PENDING, etc.) los ignoramos — sólo aplicamos al final.
  return Response.json({
    ok: true,
    applied: false,
    reason: `txStatus=${txn.status} no terminal`,
  });
}

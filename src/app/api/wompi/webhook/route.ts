import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { sendText } from '@/lib/kapso/client';
import { recordMessage } from '@/lib/messaging';
import { getMessage } from '@/lib/bot/messages/catalog';
import { render } from '@/lib/bot/messages/render';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Webhook de Wompi (mock por ahora).
 *
 * Acepta dos formatos:
 * - application/json: { orderId, status }
 * - application/x-www-form-urlencoded: orderId=...&status=APPROVED (mock-checkout)
 *
 * Transiciones permitidas a pagado: `borrador → pagado` (checkout web) y
 * `nuevo → pagado` (flujo legacy del bot / POST /api/orders). Cualquier otro
 * estado se ignora (idempotencia: un segundo webhook no re-procesa).
 *
 * Revalidación de monto: como el carrito del checkout web es editable hasta
 * pagar, al aprobar revalidamos que el monto pagado coincida con `orders.total`.
 * En el MOCK actual el form no envía monto (`amount` ausente) ⇒ se omite la
 * verificación y se aprueba. Con Wompi REAL, `amount` entra desde
 * `data.transaction.amount_in_cents` (dividir /100 para COP) y si NO coincide
 * con el total actual NO se aprueba (el cliente editó tras generar el link).
 *
 * Side effects al aprobar:
 *  1. orders.status = 'pagado'
 *  2. chats.flow_state.step = 'finalizado' (cierra el flujo)
 *  3. envío de WhatsApp al cliente "¡Pago recibido!"
 *
 * Cuando llegue Wompi real:
 * - Verificar X-Event-Checksum con signing secret
 * - Payload tiene shape distinto (event=transaction.updated, data.transaction.status=APPROVED)
 * - Mapear `reference` (que enviamos al crear checkout) al orderId
 * - Tomar `amount` de `data.transaction.amount_in_cents / 100` y pasarlo acá.
 */

/** Estados desde los que una orden puede pasar a `pagado`. */
const PAYABLE_STATUSES = ['borrador', 'nuevo'] as const;

const jsonSchema = z.object({
  orderId: z.string().min(1),
  status: z.enum(['APPROVED', 'DECLINED', 'VOIDED', 'ERROR']),
  // Monto pagado en COP (entero). Opcional: el mock no lo envía. Con Wompi real
  // llega para revalidar contra orders.total. `coerce` tolera el string del form.
  amount: z.coerce.number().int().nonnegative().optional(),
});

async function readPayload(request: NextRequest): Promise<unknown> {
  const ct = request.headers.get('content-type') ?? '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  }
  return await request.json();
}

export async function POST(request: NextRequest) {
  let parsed;
  try {
    parsed = jsonSchema.parse(await readPayload(request));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid payload' }, { status: 400 });
  }

  if (parsed.status !== 'APPROVED') {
    console.log('[wompi webhook] pago no aprobado, no cambia estado', {
      orderId: parsed.orderId,
      status: parsed.status,
    });
    return responder(request, { ok: true, applied: false, reason: `status=${parsed.status}` });
  }

  const sb = supabaseAdmin();

  // Cargar orden con phone + total + nombre del cliente
  const { data: order, error: getErr } = await sb
    .from('orders')
    .select('id, status, phone, total, customer:customers(name)')
    .eq('id', parsed.orderId)
    .single();

  if (getErr || !order) {
    return responder(request, { ok: false, error: 'Pedido no encontrado' }, 404);
  }

  if (!(PAYABLE_STATUSES as readonly string[]).includes(order.status)) {
    console.log('[wompi webhook] pedido no está en un estado pagable, ignorando', {
      orderId: order.id,
      currentStatus: order.status,
    });
    return responder(request, {
      ok: true,
      applied: false,
      reason: `status=${order.status}, esperaba ${PAYABLE_STATUSES.join(' o ')}`,
    });
  }

  // Revalidar monto (carrito editable hasta pagar). El mock no manda `amount` ⇒
  // se omite. Con Wompi real, si no coincide con el total actual NO aprobamos.
  if (parsed.amount != null && parsed.amount !== (order.total ?? 0)) {
    console.warn('[wompi webhook] monto no coincide con total actual, no aprobando', {
      orderId: order.id,
      amount: parsed.amount,
      total: order.total,
    });
    return responder(request, {
      ok: true,
      applied: false,
      reason: `monto recibido (${parsed.amount}) != total actual (${order.total})`,
    });
  }

  const { error: updErr } = await sb.from('orders').update({ status: 'pagado' }).eq('id', order.id);
  if (updErr) {
    console.error('[wompi webhook] update error', updErr);
    return responder(request, { ok: false, error: updErr.message }, 500);
  }

  console.log('[wompi webhook] orden pagada', { orderId: order.id });

  // Side effects:
  // 1. Notificar al cliente por WhatsApp
  // 2. Cerrar el flow_state del chat
  // No fallamos la respuesta si fallan estos pasos — el pago ya se aprobó.
  try {
    const customer = Array.isArray(order.customer) ? order.customer[0] : order.customer;
    const firstName = (customer?.name ?? '').split(' ')[0] || '';
    const saludo = firstName ? `Hola ${firstName}` : 'Hola';
    const pagadoMsg = await getMessage('notif.pagado');
    const body = render(pagadoMsg.body, { saludo, nombre: firstName });

    const result = await sendText(order.phone, body);
    const wamid = result.messages?.[0]?.id ?? null;
    await recordMessage({
      phone: order.phone,
      direction: 'bot',
      body,
      kapsoMessageId: wamid,
    });

    // Cerrar el flujo (flow_state.step = 'finalizado'). En el bot mínimo el
    // flow_state ya no guarda cart/customer (eso vive en la tienda web).
    const chatId = `wa:${order.phone}`;
    await sb
      .from('chats')
      .update({
        flow_state: { step: 'finalizado', orderId: order.id },
        flow_updated_at: new Date().toISOString(),
      })
      .eq('id', chatId);
  } catch (err) {
    console.error('[wompi webhook] notif error (estado ya actualizado)', err);
  }

  return responder(request, { ok: true, applied: true, orderId: order.id, newStatus: 'pagado' });
}

function responder(request: NextRequest, json: Record<string, unknown>, status = 200): Response {
  const ct = request.headers.get('content-type') ?? '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    const ok = json.ok === true && json.applied !== false;
    const title = ok ? '✅ Pago aprobado' : '❌ Pago no procesado';
    const color = ok ? '#16A34A' : '#DC2626';
    const subtitle = ok
      ? 'Tu pedido pasó a estado <strong>pagado</strong>.'
      : (json.reason ?? json.error ?? 'No se pudo procesar el pago.');
    return new Response(
      `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bros and Subs</title></head>
<body style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 80px auto; padding: 24px; text-align: center; background: #fff;">
  <h1 style="color: ${color}; margin: 0 0 12px;">${title}</h1>
  <p style="color: #333; margin: 0 0 8px;">${subtitle}</p>
  <p style="color: #666; font-size: 14px; margin: 24px 0 0;">Puedes cerrar esta ventana y volver a WhatsApp.</p>
</body></html>`,
      { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
  return Response.json(json, { status });
}

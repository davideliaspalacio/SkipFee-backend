import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { sendText } from '@/lib/kapso/client';
import { recordMessage } from '@/lib/messaging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Webhook de Wompi (mock por ahora).
 *
 * Acepta dos formatos:
 * - application/json: { orderId, status }
 * - application/x-www-form-urlencoded: orderId=...&status=APPROVED (mock-checkout)
 *
 * Solo transición permitida: nuevo → pagado.
 * Side effects al aprobar:
 *  1. orders.status = 'pagado'
 *  2. chats.flow_state.step = 'finalizado' (cierra el flujo)
 *  3. envío de WhatsApp al cliente "¡Pago recibido!"
 *
 * Cuando llegue Wompi real:
 * - Verificar X-Event-Checksum con signing secret
 * - Payload tiene shape distinto (event=transaction.updated, data.transaction.status=APPROVED)
 * - Mapear `reference` (que enviamos al crear checkout) al orderId
 */
const jsonSchema = z.object({
  orderId: z.string().min(1),
  status: z.enum(['APPROVED', 'DECLINED', 'VOIDED', 'ERROR']),
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

  // Cargar orden con phone + nombre del cliente
  const { data: order, error: getErr } = await sb
    .from('orders')
    .select('id, status, phone, customer:customers(name)')
    .eq('id', parsed.orderId)
    .single();

  if (getErr || !order) {
    return responder(request, { ok: false, error: 'Pedido no encontrado' }, 404);
  }

  if (order.status !== 'nuevo') {
    console.log('[wompi webhook] pedido ya no está en nuevo, ignorando', {
      orderId: order.id,
      currentStatus: order.status,
    });
    return responder(request, {
      ok: true,
      applied: false,
      reason: `status=${order.status}, esperaba nuevo`,
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

    // Cerrar el flujo (flow_state.step = 'finalizado')
    const chatId = `wa:${order.phone}`;
    await sb
      .from('chats')
      .update({
        flow_state: {
          step: 'finalizado',
          cart: { items: [] },
          customer: {},
          orderId: order.id,
        },
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

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { chatIdFor, recordMessage } from '@/lib/messaging';
import { verifyWebhookSignature } from '@/lib/wompi/signature';
import { wompiConfigFor } from '@/lib/integrations';
import { getMessage } from '@/lib/bot/messages/catalog';
import { render } from '@/lib/bot/messages/render';
import { redeemRewardForOrder } from '@/lib/orders/rewards';
import { botSendTextMsg } from '@/lib/bot/sender';
import {
  isShareReference,
  findShareByReference,
  settleShareApproved,
  settleShareFailed,
} from '@/lib/dinein-split';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/wompi/:companyId  (público — lo llama Wompi)
 *
 * Webhook de pago POR EMPRESA. `:companyId` es el SLUG de la empresa (el mismo
 * que viaja en el resto del árbol multi-empresa). Resolvemos la empresa por slug
 * con `supabaseAdmin()` y usamos SU `wompi_events_secret` (vía `wompiConfigFor`)
 * para verificar la firma del evento. TODA query se scopea por `company_id`.
 *
 * Acepta dos formatos (unifica la ruta real y el mock legacy):
 *  - application/json: evento real de Wompi (`transaction.updated` + firma SHA256).
 *  - application/x-www-form-urlencoded: mock-checkout (`orderId=...&status=APPROVED`),
 *    que NO trae firma ni monto → en modo mock se aprueba sin verificar firma.
 *
 * Defensa en profundidad (formato JSON / Wompi real):
 *   1. Verificar firma SHA256 con el events secret de ESTA empresa.
 *   2. Idempotencia por `orders.wompi_tx_id`.
 *   3. Revalidar `currency == 'COP'` y `amount_in_cents == orders.total * 100`.
 *   4. Solo aplicar si el estado actual es pagable.
 *
 * Transiciones:
 *   - APPROVED              ⇒ status='pagado' + WhatsApp "pago recibido" + cierra flow
 *   - DECLINED/ERROR/VOIDED ⇒ status='borrador' + guarda status_message
 *
 * Devuelve 200 salvo 400 (payload inválido), 401 (firma inválida), 404 (empresa
 * no encontrada). El campo `applied` indica si efectivamente se mutó algo.
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

/** Resuelve el uuid de la empresa a partir del slug del path. */
async function resolveCompanyId(slug: string): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from('companies')
    .select('id, status')
    .eq('slug', slug)
    .maybeSingle();
  if (!data || data.status === 'suspended') return null;
  return data.id as string;
}

/** Side effect compartido: notifica al cliente y cierra el flujo del chat. */
async function notifyPaid(
  sb: ReturnType<typeof supabaseAdmin>,
  companyId: string,
  order: { id: string; phone: string; customer: OrderRow['customer'] },
): Promise<void> {
  try {
    const customer = Array.isArray(order.customer) ? order.customer[0] : order.customer;
    const firstName = (customer?.name ?? '').split(' ')[0] || '';
    const saludo = firstName ? `Hola ${firstName}` : 'Hola';
    const pagadoMsg = await getMessage('notif.pagado', companyId);
    const body = render(pagadoMsg.body, { saludo, nombre: firstName });

    // Envío por el proveedor de WhatsApp de ESTA empresa (Kapso o Evolution).
    const result = await botSendTextMsg(companyId, order.phone, body);
    const wamid = result.messages?.[0]?.id ?? null;
    await recordMessage({
      phone: order.phone,
      direction: 'bot',
      body,
      kapsoMessageId: wamid,
      companyId,
    });

    const chatId = chatIdFor(companyId, order.phone);
    await sb
      .from('chats')
      .update({
        flow_state: { step: 'finalizado', orderId: order.id },
        flow_updated_at: new Date().toISOString(),
      })
      .eq('id', chatId)
      .eq('company_id', companyId);

    // Post-venta (Tarea 3): canjear cupón de postre vigente en este pedido.
    await redeemRewardForOrder({ sb, orderId: order.id, phone: order.phone, companyId });
  } catch (err) {
    console.error('[wompi webhook] notif error (orden ya pagada)', err);
  }
}

// ---------------------------------------------------------------------------
// Mock (form-urlencoded): orderId + status, sin firma ni monto.
// ---------------------------------------------------------------------------

const mockSchema = z.object({
  orderId: z.string().min(1),
  status: z.enum(['APPROVED', 'DECLINED', 'VOIDED', 'ERROR']),
  amount: z.coerce.number().int().nonnegative().optional(),
});

async function handleMock(
  request: NextRequest,
  companyId: string,
  form: Record<string, unknown>,
): Promise<Response> {
  let parsed;
  try {
    parsed = mockSchema.parse(form);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid payload' }, { status: 400 });
  }

  const sb = supabaseAdmin();

  // Split de mesa (mock): el reference-porción viaja como `orderId` del form.
  if (isShareReference(parsed.orderId)) {
    const share = await findShareByReference(sb, companyId, parsed.orderId);
    if (!share) {
      return respondMock(request, { ok: true, applied: false, reason: 'porción no encontrada' }, 404);
    }
    if (parsed.status !== 'APPROVED') {
      const r = await settleShareFailed(
        sb,
        companyId,
        share,
        `mock-${Date.now()}`,
        `Pago ${parsed.status.toLowerCase()}`,
      );
      return respondMock(request, { ok: true, split: true, ...r });
    }
    const cents = parsed.amount != null ? parsed.amount * 100 : share.amount * 100;
    const r = await settleShareApproved(sb, companyId, share, `mock-${Date.now()}`, cents);
    return respondMock(request, { ok: true, split: true, ...r });
  }

  const { data: order } = (await sb
    .from('orders')
    .select('id, status, phone, total, wompi_tx_id, customer:customers(name)')
    .eq('id', parsed.orderId)
    .eq('company_id', companyId)
    .single()) as { data: OrderRow | null };

  if (!order) {
    return respondMock(request, { ok: false, error: 'Pedido no encontrado' }, 404);
  }

  if (parsed.status !== 'APPROVED') {
    return respondMock(request, { ok: true, applied: false, reason: `status=${parsed.status}` });
  }

  if (!(PAYABLE_STATUSES as readonly string[]).includes(order.status)) {
    return respondMock(request, {
      ok: true,
      applied: false,
      reason: `status=${order.status}, esperaba ${PAYABLE_STATUSES.join(' o ')}`,
    });
  }

  if (parsed.amount != null && parsed.amount !== (order.total ?? 0)) {
    return respondMock(request, {
      ok: true,
      applied: false,
      reason: `monto recibido (${parsed.amount}) != total actual (${order.total})`,
    });
  }

  const { error: updErr } = await sb
    .from('orders')
    .update({ status: 'pagado' })
    .eq('id', order.id)
    .eq('company_id', companyId);
  if (updErr) {
    console.error('[wompi webhook mock] update error', updErr);
    return respondMock(request, { ok: false, error: updErr.message }, 500);
  }

  await notifyPaid(sb, companyId, order);
  return respondMock(request, { ok: true, applied: true, orderId: order.id, newStatus: 'pagado' });
}

function respondMock(request: NextRequest, json: Record<string, unknown>, status = 200): Response {
  const ct = request.headers.get('content-type') ?? '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    const ok = json.ok === true && json.applied !== false;
    const title = ok ? '✅ Pago aprobado' : '❌ Pago no procesado';
    const color = ok ? '#16A34A' : '#DC2626';
    const subtitle = ok
      ? 'Tu pedido pasó a estado <strong>pagado</strong>.'
      : (json.reason ?? json.error ?? 'No se pudo procesar el pago.');
    return new Response(
      `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pago</title></head>
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

// ---------------------------------------------------------------------------
// Real (JSON): evento firmado de Wompi.
// ---------------------------------------------------------------------------

async function handleReal(
  request: NextRequest,
  companyId: string,
  event: WompiEvent,
): Promise<Response> {
  // Verificar firma con el events secret de ESTA empresa.
  const { eventsSecret } = await wompiConfigFor(companyId);
  const headerChecksum = request.headers.get('x-event-checksum');
  if (!verifyWebhookSignature(event, headerChecksum, eventsSecret)) {
    console.warn('[wompi webhook real] firma inválida', {
      companyId,
      event: event?.event,
      txId: event?.data?.transaction?.id,
    });
    return Response.json({ ok: false, error: 'invalid signature' }, { status: 401 });
  }

  if (event.event !== 'transaction.updated') {
    return Response.json({ ok: true, applied: false, reason: `event=${event.event} ignorado` });
  }

  const txn = event.data?.transaction;
  if (!txn?.id || !txn.reference) {
    return Response.json({ ok: true, applied: false, reason: 'transaction sin id/reference' });
  }

  const sb = supabaseAdmin();

  // Split de mesa: si el reference es de una porción (sp_*), liquidarla y (si se
  // completó el total) cerrar la cuenta. No toca el flujo normal de órdenes.
  if (isShareReference(txn.reference)) {
    const share = await findShareByReference(sb, companyId, txn.reference);
    if (!share) {
      return Response.json({ ok: true, applied: false, reason: 'porción no encontrada' });
    }
    if (txn.currency !== 'COP') {
      return Response.json({ ok: true, applied: false, reason: `currency ${txn.currency} != COP` });
    }
    if (txn.status === 'APPROVED') {
      const r = await settleShareApproved(sb, companyId, share, txn.id, txn.amount_in_cents);
      return Response.json({ ok: true, split: true, ...r });
    }
    if (txn.status === 'DECLINED' || txn.status === 'VOIDED' || txn.status === 'ERROR') {
      const r = await settleShareFailed(
        sb,
        companyId,
        share,
        txn.id,
        txn.status_message ?? `Pago ${txn.status.toLowerCase()}`,
      );
      return Response.json({ ok: true, split: true, ...r });
    }
    return Response.json({ ok: true, applied: false, reason: `txStatus=${txn.status} no terminal` });
  }

  // Cargar la orden por reference (== orderId) SCOPEADA por empresa.
  const { data: order } = (await sb
    .from('orders')
    .select('id, status, phone, total, wompi_tx_id, customer:customers(name)')
    .eq('id', txn.reference)
    .eq('company_id', companyId)
    .single()) as { data: OrderRow | null };

  if (!order) {
    console.warn('[wompi webhook real] orden no encontrada', { companyId, reference: txn.reference });
    return Response.json({ ok: true, applied: false, reason: 'orden no encontrada' });
  }

  // Idempotencia.
  if (order.wompi_tx_id === txn.id && !(PAYABLE_STATUSES as readonly string[]).includes(order.status)) {
    return Response.json({ ok: true, applied: false, reason: 'idempotent: ya procesado' });
  }

  if (txn.currency !== 'COP') {
    console.warn('[wompi webhook real] currency inesperada', { currency: txn.currency });
    return Response.json({ ok: true, applied: false, reason: `currency ${txn.currency} != COP` });
  }

  if (!(PAYABLE_STATUSES as readonly string[]).includes(order.status)) {
    return Response.json({
      ok: true,
      applied: false,
      reason: `status=${order.status}, esperaba ${PAYABLE_STATUSES.join(' o ')}`,
    });
  }

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

  if (txn.status === 'APPROVED') {
    const { error: updErr } = await sb
      .from('orders')
      .update({ status: 'pagado', wompi_tx_id: txn.id, wompi_status_message: null })
      .eq('id', order.id)
      .eq('company_id', companyId);
    if (updErr) {
      console.error('[wompi webhook real] update pagado error', updErr);
      return Response.json({ ok: false, error: updErr.message }, { status: 500 });
    }
    console.log('[wompi webhook real] orden pagada', { companyId, orderId: order.id, txId: txn.id });

    await notifyPaid(sb, companyId, order);

    return Response.json({ ok: true, applied: true, orderId: order.id, newStatus: 'pagado' });
  }

  if (txn.status === 'DECLINED' || txn.status === 'VOIDED' || txn.status === 'ERROR') {
    const { error: updErr } = await sb
      .from('orders')
      .update({
        status: 'borrador',
        wompi_tx_id: txn.id,
        wompi_status_message: txn.status_message ?? `Pago ${txn.status.toLowerCase()}`,
      })
      .eq('id', order.id)
      .eq('company_id', companyId);
    if (updErr) {
      console.error('[wompi webhook real] update borrador error', updErr);
      return Response.json({ ok: false, error: updErr.message }, { status: 500 });
    }
    console.log('[wompi webhook real] pago no aprobado, orden vuelve a borrador', {
      companyId,
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

  return Response.json({ ok: true, applied: false, reason: `txStatus=${txn.status} no terminal` });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, ctx: { params: Promise<{ companyId: string }> }) {
  const { companyId: slug } = await ctx.params;

  const companyId = await resolveCompanyId(slug);
  if (!companyId) {
    return Response.json({ ok: false, error: 'Empresa no encontrada' }, { status: 404 });
  }

  const ct = request.headers.get('content-type') ?? '';

  // Mock-checkout: form-urlencoded sin firma.
  if (ct.includes('application/x-www-form-urlencoded')) {
    const form = await request.formData();
    return handleMock(request, companyId, Object.fromEntries(form.entries()));
  }

  // Wompi real: JSON firmado.
  let event: WompiEvent;
  try {
    event = (await request.json()) as WompiEvent;
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  return handleReal(request, companyId, event);
}

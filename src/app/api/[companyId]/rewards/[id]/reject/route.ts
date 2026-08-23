import { z } from 'zod';
import { botSendTextMsg } from '@/lib/bot/sender';
import { chatIdFor, recordMessage } from '@/lib/messaging';
import { getMessage } from '@/lib/bot/messages/catalog';
import { render } from '@/lib/bot/messages/render';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/<companyId>/rewards/:id/reject  (Tarea 3)
 *
 * El operario no pudo verificar la reseña → status='rechazado'. Opcionalmente
 * avisa al cliente (notify=false para rechazar en silencio). Solo aplica sobre
 * rewards 'pendiente' de LA empresa.
 *
 * Multi-empresa: el envío sale por el proveedor de WhatsApp de LA empresa
 * (`botSendTextMsg` → Kapso o Evolution) y tanto el catálogo de mensajes como
 * la persistencia van scopeados por `company_id`.
 */
const bodySchema = z.object({
  notes: z.string().max(500).optional(),
  notify: z.boolean().optional(),
});

export const POST = withTenant<{ companyId: string; id: string }>(async (request, ctx, params) => {
  const { id } = params;

  let body: { notes?: string; notify?: boolean } = {};
  try {
    body = bodySchema.parse(await request.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return Response.json({ ok: false, errors: err.issues }, { status: 400 });
  }

  const sb = ctx.db;
  const companyId = ctx.company.id;
  const { data: reward, error } = await sb
    .from('rewards')
    .select('id, phone, status')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle();
  if (error || !reward) return Response.json({ ok: false, error: 'Cupón no encontrado' }, { status: 404 });
  const r = reward as { id: string; phone: string; status: string };
  if (r.status !== 'pendiente') {
    return Response.json({ ok: false, error: `No se puede rechazar (estado ${r.status})` }, { status: 409 });
  }

  const { error: updErr } = await sb
    .from('rewards')
    .update({ status: 'rechazado', notes: body.notes ?? null })
    .eq('company_id', companyId)
    .eq('id', id);
  if (updErr) return Response.json({ ok: false, error: updErr.message }, { status: 500 });

  // Caso cerrado (reseña no verificada): el chat ya no necesita atención humana →
  // vuelve al bot para que el cliente pueda seguir interactuando.
  await sb
    .from('chats')
    .update({ status: 'bot' })
    .eq('company_id', companyId)
    .eq('id', chatIdFor(companyId, r.phone));

  if (body.notify !== false) {
    try {
      const m = await getMessage('reward.rechazado', ctx.company.id);
      const bodyMsg = render(m.body, {});
      const result = await botSendTextMsg(ctx.company.id, r.phone, bodyMsg);
      await recordMessage({
        phone: r.phone,
        direction: 'bot',
        body: bodyMsg,
        kapsoMessageId: result.messages?.[0]?.id ?? null,
        companyId,
      });
    } catch (err) {
      console.error('[rewards reject] notif error', err);
    }
  }

  return Response.json({ ok: true, reward: { id, status: 'rechazado' } });
});

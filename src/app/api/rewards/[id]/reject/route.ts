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
 * POST /api/rewards/:id/reject  (Tarea 3)
 *
 * El operario no pudo verificar la reseña → status='rechazado'. Opcionalmente
 * avisa al cliente (notify=false para rechazar en silencio). Solo aplica sobre
 * rewards 'pendiente'.
 */
const bodySchema = z.object({
  notes: z.string().max(500).optional(),
  notify: z.boolean().optional(),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let body: { notes?: string; notify?: boolean } = {};
  try {
    body = bodySchema.parse(await request.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return Response.json({ ok: false, errors: err.issues }, { status: 400 });
  }

  const sb = supabaseAdmin();
  const { data: reward, error } = await sb
    .from('rewards')
    .select('id, phone, status')
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
    .eq('id', id);
  if (updErr) return Response.json({ ok: false, error: updErr.message }, { status: 500 });

  if (body.notify !== false) {
    try {
      const m = await getMessage('reward.rechazado');
      const bodyMsg = render(m.body, {});
      const result = await sendText(r.phone, bodyMsg);
      await recordMessage({
        phone: r.phone,
        direction: 'bot',
        body: bodyMsg,
        kapsoMessageId: result.messages?.[0]?.id ?? null,
      });
    } catch (err) {
      console.error('[rewards reject] notif error', err);
    }
  }

  return Response.json({ ok: true, reward: { id, status: 'rechazado' } });
}

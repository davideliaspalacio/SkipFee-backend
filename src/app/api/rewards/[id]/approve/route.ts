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
 * POST /api/rewards/:id/approve  (Tarea 3)
 *
 * El operario verificó la reseña → otorga el cupón: status='otorgado',
 * vigencia = now + review_gift_expiry_days, y avisa al cliente por WhatsApp.
 * Solo aplica sobre rewards 'pendiente'.
 */
const bodySchema = z.object({ grantedBy: z.string().email().max(200).optional() });

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let body: { grantedBy?: string } = {};
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
    return Response.json({ ok: false, error: `No se puede aprobar (estado ${r.status})` }, { status: 409 });
  }

  const { data: settings } = await sb
    .from('settings')
    .select('review_gift_name, review_gift_expiry_days')
    .eq('id', 1)
    .maybeSingle();
  const postre = (settings?.review_gift_name as string) ?? 'Postre';
  const expiryDays = (settings?.review_gift_expiry_days as number) ?? 30;
  const expiresAt = new Date(Date.now() + expiryDays * 86_400_000).toISOString();

  const { error: updErr } = await sb
    .from('rewards')
    .update({
      status: 'otorgado',
      granted_at: new Date().toISOString(),
      granted_by: body.grantedBy ?? null,
      expires_at: expiresAt,
    })
    .eq('id', id);
  if (updErr) return Response.json({ ok: false, error: updErr.message }, { status: 500 });

  // La reseña quedó verificada: el chat ya no necesita atención humana → vuelve
  // al bot para que el cliente pueda seguir interactuando (p. ej. pedir de nuevo).
  await sb.from('chats').update({ status: 'bot' }).eq('id', `wa:${r.phone}`);

  // Avisar al cliente (no rompe la respuesta si falla).
  try {
    const m = await getMessage('reward.aprobado');
    const bodyMsg = render(m.body, { postre });
    const result = await sendText(r.phone, bodyMsg);
    await recordMessage({
      phone: r.phone,
      direction: 'bot',
      body: bodyMsg,
      kapsoMessageId: result.messages?.[0]?.id ?? null,
    });
  } catch (err) {
    console.error('[rewards approve] notif error', err);
  }

  return Response.json({ ok: true, reward: { id, status: 'otorgado', expiresAt } });
}

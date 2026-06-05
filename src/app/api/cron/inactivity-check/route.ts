import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendText } from '@/lib/kapso/client';
import { recordMessage } from '@/lib/messaging';
import { env } from '@/lib/env';
import { getMessage } from '@/lib/bot/messages/catalog';
import { render } from '@/lib/bot/messages/render';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/cron/inactivity-check
 *
 * Lo invoca pg_cron de Supabase cada minuto. Busca chats con flow_state
 * activo (status='bot', step != 'finalizado') donde:
 *
 * - last_message_at hace 5-30 min → manda nudge personalizado por step
 *   y marca como "ya recordado" para no spammear cada minuto
 * - last_message_at hace > 30 min → limpia el flow_state (sin mensaje,
 *   evita molestar a horas raras)
 *
 * Auth: header x-cron-secret debe coincidir con env.CRON_SECRET.
 * Si CRON_SECRET no está configurada, el endpoint responde 503 (no
 * queremos endpoint público para nudge automatizado).
 */

const NUDGE_AFTER_MIN = 5;
const RESET_AFTER_MIN = 30;

// Los recordatorios por step son editables desde la UI (`nudge.*`). Ver
// `@/lib/bot/messages/defaults`. Antes vivían acá hardcodeados y con llaves
// del flujo viejo (carta/cantidad/pago…) que ya no matcheaban los steps.

interface ChatRow {
  id: string;
  phone: string;
  flow_state: {
    step?: string;
    reminderSentAt?: string;
  } | null;
  last_message_at: string;
}

export async function POST(request: NextRequest) {
  // 1. Auth
  const secret = request.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return Response.json({ ok: false, error: 'CRON_SECRET no configurado' }, { status: 503 });
  }
  if (secret !== expected) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const sb = supabaseAdmin();
  const now = new Date();
  const nudgeCutoff = new Date(now.getTime() - NUDGE_AFTER_MIN * 60_000).toISOString();
  const resetCutoff = new Date(now.getTime() - RESET_AFTER_MIN * 60_000).toISOString();

  // 2. Buscar chats candidatos: bot, flow_state existe, último mensaje > 5min
  // Filtramos en JS los step='finalizado' y los ya nudgeados.
  const { data: chats, error } = await sb
    .from('chats')
    .select('id, phone, flow_state, last_message_at')
    .eq('status', 'bot')
    .lt('last_message_at', nudgeCutoff)
    .not('flow_state', 'is', null);

  if (error) {
    console.error('[cron/inactivity-check] query error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const candidates = (chats ?? []) as ChatRow[];
  let nudged = 0;
  let reset = 0;

  for (const chat of candidates) {
    const step = chat.flow_state?.step;
    if (!step || step === 'finalizado') continue;
    // Los pasos de post-venta (encuesta/reseña) no se nudgean ni se resetean:
    // el cliente puede responder horas después de entregado.
    if (step.startsWith('postventa')) continue;

    // ¿Llegó al reset de 30 min? Limpiamos el flow_state silenciosamente.
    if (chat.last_message_at < resetCutoff) {
      await sb
        .from('chats')
        .update({ flow_state: null, flow_updated_at: now.toISOString() })
        .eq('id', chat.id);
      reset++;
      continue;
    }

    // ¿Ya le mandamos nudge esta ronda? (evita re-recordarle cada minuto)
    if (chat.flow_state?.reminderSentAt) continue;

    // Recordatorio editable por step; cae a `nudge.default` si no hay uno propio.
    let nudge = await getMessage(`nudge.${step}`);
    if (!nudge.body) nudge = await getMessage('nudge.default');
    if (!nudge.enabled) continue; // recordatorio apagado desde la UI
    const nudgeBody = render(nudge.body);

    try {
      const result = await sendText(chat.phone, nudgeBody);
      const wamid = result.messages?.[0]?.id ?? null;
      await recordMessage({
        phone: chat.phone,
        direction: 'bot',
        body: nudgeBody,
        kapsoMessageId: wamid,
      });

      // Marcar como nudgeado para no spamear cada minuto
      await sb
        .from('chats')
        .update({
          flow_state: { ...chat.flow_state, reminderSentAt: now.toISOString() },
        })
        .eq('id', chat.id);
      nudged++;
    } catch (err) {
      console.error('[cron/inactivity-check] nudge fail', { chatId: chat.id, err });
    }
  }

  // Touch env.NODE_ENV para que TypeScript no se queje del unused import
  void env.NODE_ENV;

  return Response.json({
    ok: true,
    checkedAt: now.toISOString(),
    candidates: candidates.length,
    nudged,
    reset,
  });
}

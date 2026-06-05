import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendSurvey } from '@/lib/bot/flow/handlers';
import { saveFlowState } from '@/lib/bot/flow/persistence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/cron/survey-dispatch  (Tarea 3)
 *
 * pg_cron lo llama cada 5 min (migración 0025). Envía la encuesta 1–5 a los
 * pedidos entregados hace ≥ survey_delay_hours y ≤ 24h (ventana de sesión de
 * WhatsApp) que aún no la recibieron. Marca order_surveys.sent_at y deja el
 * chat esperando la calificación (flow_state.step = postventa_encuesta).
 *
 * Auth: header x-cron-secret == env CRON_SECRET (igual que inactivity-check).
 */

const WINDOW_MAX_H = 24;

interface PendingSurvey {
  id: string;
  order_id: string;
  phone: string;
  created_at: string;
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return Response.json({ ok: false, error: 'CRON_SECRET no configurado' }, { status: 503 });
  }
  if (secret !== expected) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const sb = supabaseAdmin();

  // 1. Config de encuesta.
  const { data: settings } = await sb
    .from('settings')
    .select('survey_enabled, survey_delay_hours')
    .eq('id', 1)
    .maybeSingle();
  const enabled = (settings?.survey_enabled as boolean) ?? true;
  const delayH = (settings?.survey_delay_hours as number) ?? 1;
  if (!enabled) {
    return Response.json({ ok: true, skipped: 'survey-disabled', sent: 0 });
  }

  const now = Date.now();
  const delayCutoff = new Date(now - delayH * 3_600_000).toISOString(); // entregado hace ≥ delay
  const windowStart = new Date(now - WINDOW_MAX_H * 3_600_000).toISOString(); // y ≤ 24h

  // 2. Encuestas pendientes de enviar dentro de la ventana.
  const { data: pending, error } = await sb
    .from('order_surveys')
    .select('id, order_id, phone, created_at')
    .is('sent_at', null)
    .lte('created_at', delayCutoff)
    .gte('created_at', windowStart)
    .limit(100);
  if (error) {
    console.error('[cron/survey-dispatch] query error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  let sent = 0;
  let skipped = 0;

  for (const s of (pending ?? []) as PendingSurvey[]) {
    const chatId = `wa:${s.phone}`;
    // No interrumpir un chat en manos de un humano ni un pedido en curso.
    const { data: chat } = await sb
      .from('chats')
      .select('status, flow_state')
      .eq('id', chatId)
      .maybeSingle();
    const status = (chat?.status as string) ?? 'bot';
    const step = (chat?.flow_state as { step?: string } | null)?.step;
    const busy = !!step && step !== 'finalizado';
    if (status !== 'bot' || busy) {
      skipped++;
      continue;
    }

    try {
      await sendSurvey({ phone: s.phone, orderId: s.order_id });
      await sb
        .from('order_surveys')
        .update({ sent_at: new Date().toISOString() })
        .eq('id', s.id);
      await saveFlowState(chatId, { step: 'postventa_encuesta', surveyOrderId: s.order_id });
      sent++;
    } catch (err) {
      console.error('[cron/survey-dispatch] envío fail', { surveyId: s.id, err });
    }
  }

  return Response.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    candidates: pending?.length ?? 0,
    sent,
    skipped,
  });
}

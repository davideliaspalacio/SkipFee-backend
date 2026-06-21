import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendDeliverySurvey } from '@/lib/orders/survey';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/cron/survey-dispatch
 *
 * Lo invoca pg_cron de Supabase cada minuto (ver
 * supabase/migrations/0035_survey_dispatch_cron.sql). Manda la encuesta
 * "califícanos" a los pedidos ENTREGADOS hace ≥ `settings.survey_delay_minutes`
 * (default 30) y ≤ 24 h, que todavía no la recibieron.
 *
 * El delay difiere la encuesta respecto del aviso de entrega (antes se mandaba
 * síncrono al marcar "entregado"). La ventana de 24 h evita encuestar
 * conversaciones viejas que ya cayeron fuera de la ventana de servicio de
 * WhatsApp (heurística: hora de entrega ≈ última actividad del cliente).
 *
 * Auth: header `x-cron-secret` == `CRON_SECRET` (mismo patrón que
 * /api/cron/inactivity-check y /api/cron/expire-drafts). Sin `CRON_SECRET` → 503.
 *
 * Idempotente: cada pedido tiene a lo sumo una fila en `order_surveys`
 * (`order_id` UNIQUE); descartamos los que ya tienen `sent_at`. Además
 * `sendDeliverySurvey` saltea chats en humano, a mitad de otro flujo, o
 * encuestados hace poco (survey_min_days).
 *
 * Multi-empresa: pg_cron llama un endpoint global; iteramos por empresa activa.
 * `settings` (switch + delay) y `orders` se leen scopeados por `company_id`, y
 * `sendDeliverySurvey` recibe `companyId` para enviar con el Kapso de la empresa
 * y scopear sus lookups (settings/chat/order_surveys).
 */
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
  const now = new Date();

  const { data: companies, error: companiesErr } = await sb
    .from('companies')
    .select('id')
    .eq('status', 'active');

  if (companiesErr) {
    console.error('[cron/survey-dispatch] companies error', companiesErr);
    return Response.json({ ok: false, error: companiesErr.message }, { status: 500 });
  }

  let totalCandidates = 0;
  let sent = 0;
  let skipped = 0;

  for (const company of companies ?? []) {
    const companyId = company.id as string;

    // Switch + delay configurables por empresa (Configuración → Reseñas).
    const { data: settings } = await sb
      .from('settings')
      .select('survey_enabled, survey_delay_minutes')
      .eq('company_id', companyId)
      .maybeSingle();
    if ((settings?.survey_enabled ?? true) === false) continue; // empresa con encuesta apagada
    const delayMin =
      (settings as { survey_delay_minutes?: number } | null)?.survey_delay_minutes ?? 30;

    // Ventana: entregado hace ≥ delayMin (delivered_at < cutoff) y ≤ 24 h (≥ floor).
    const cutoff = new Date(now.getTime() - delayMin * 60_000).toISOString();
    const floor = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();

    const { data: orders, error } = await sb
      .from('orders')
      .select('id, phone, delivered_at')
      .eq('company_id', companyId)
      .eq('status', 'entregado')
      .gte('delivered_at', floor)
      .lt('delivered_at', cutoff);

    if (error) {
      console.error('[cron/survey-dispatch] query error', { companyId, error });
      continue;
    }

    const candidates = (orders ?? []) as Array<{ id: string; phone: string }>;
    totalCandidates += candidates.length;

    // Descartar los pedidos que ya tienen la encuesta enviada (order_surveys.sent_at).
    let pending = candidates;
    if (candidates.length > 0) {
      const ids = candidates.map(o => o.id);
      const { data: existing } = await sb
        .from('order_surveys')
        .select('order_id, sent_at')
        .eq('company_id', companyId)
        .in('order_id', ids);
      const sentIds = new Set(
        ((existing ?? []) as Array<{ order_id: string; sent_at: string | null }>)
          .filter(s => s.sent_at)
          .map(s => s.order_id),
      );
      pending = candidates.filter(o => !sentIds.has(o.id));
    }

    for (const order of pending) {
      const result = await sendDeliverySurvey({
        sb,
        orderId: order.id,
        phone: order.phone,
        companyId,
      });
      if (result.sent) sent++;
      else skipped++;
    }
  }

  if (sent > 0) {
    console.log('[cron/survey-dispatch] encuestas enviadas', { sent, skipped, at: now.toISOString() });
  }

  return Response.json({
    ok: true,
    checkedAt: now.toISOString(),
    candidates: totalCandidates,
    sent,
    skipped,
  });
}

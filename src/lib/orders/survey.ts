import type { SupabaseClient } from '@supabase/supabase-js';
import { sendSurvey } from '@/lib/bot/flow/handlers';
import { saveFlowState } from '@/lib/bot/flow/persistence';

/**
 * Envía la encuesta de satisfacción 1–5 JUSTO DESPUÉS del mensaje de "entregado"
 * (síncrono, sin cron). Lo llama el PATCH de estado del pedido cuando notifica
 * la entrega por primera vez.
 *
 * No lanza: cualquier fallo se loguea (el cambio de estado y la notificación de
 * entrega ya ocurrieron, no queremos romper la respuesta del endpoint).
 */
export async function sendDeliverySurvey(opts: {
  sb: SupabaseClient;
  orderId: string;
  phone: string;
}): Promise<void> {
  const { sb, orderId, phone } = opts;
  try {
    // Respetar el switch de la UI (Configuración → Reseñas).
    const { data: settings } = await sb
      .from('settings')
      .select('survey_enabled, survey_min_days')
      .eq('id', 1)
      .maybeSingle();
    if ((settings?.survey_enabled ?? true) === false) return;

    // No interrumpir si el chat lo está atendiendo un humano.
    const chatId = `wa:${phone}`;
    const { data: chat } = await sb
      .from('chats')
      .select('status')
      .eq('id', chatId)
      .maybeSingle();
    if ((chat?.status as string | undefined) === 'human') return;

    // No re-encuestar al cliente si ya recibió una encuesta hace poco
    // (survey_min_days). 0 = sin límite. Evita molestar al recurrente.
    const minDays = (settings as { survey_min_days?: number } | null)?.survey_min_days ?? 30;
    if (minDays > 0) {
      const since = new Date(Date.now() - minDays * 86_400_000).toISOString();
      const { data: recent } = await sb
        .from('order_surveys')
        .select('id')
        .eq('phone', phone)
        .gte('sent_at', since)
        .limit(1);
      if (recent && recent.length > 0) return;
    }

    await sendSurvey({ phone, orderId });

    // Registrar la encuesta (el rating se llena cuando el cliente responde).
    await sb
      .from('order_surveys')
      .upsert(
        { order_id: orderId, phone, sent_at: new Date().toISOString() },
        { onConflict: 'order_id' },
      );

    // Dejar el chat esperando la calificación (1–5).
    await saveFlowState(chatId, { step: 'postventa_encuesta', surveyOrderId: orderId });
  } catch (err) {
    console.error('[sendDeliverySurvey] error', { orderId, err });
  }
}

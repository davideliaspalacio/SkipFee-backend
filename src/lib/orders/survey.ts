import type { SupabaseClient } from '@supabase/supabase-js';
import { sendSurvey } from '@/lib/bot/flow/handlers';
import { saveFlowState } from '@/lib/bot/flow/persistence';
import { chatIdFor } from '@/lib/messaging';

/** Resultado de intentar enviar la encuesta de un pedido (para conteo del cron). */
export interface DeliverySurveyResult {
  sent: boolean;
  /** Motivo por el que NO se envió (disabled | human | step:<x> | min_days | error). */
  skipped?: string;
}

/**
 * Steps en los que el chat está "tranquilo" y SÍ se puede mandar la encuesta:
 * sin flujo (null/undefined), en el saludo o en el menú, o ya finalizado.
 * Cualquier otro step (registro/dirección/link, o una encuesta ya en curso)
 * significa que el cliente está a mitad de algo → no lo interrumpimos.
 */
const QUIET_STEPS = new Set(['inicio', 'menu', 'finalizado']);

/**
 * Envía la encuesta de satisfacción 1–5 de un pedido entregado. La invoca el
 * cron `survey-dispatch` (app/api/cron/survey-dispatch) ~N min después de la
 * entrega (configurable: `settings.survey_delay_minutes`, default 30).
 *
 * Antes se mandaba SÍNCRONO al marcar "entregado"; ahora se difiere para no
 * encimar el aviso de entrega y dar tiempo a que el cliente reciba el pedido.
 *
 * No lanza: cualquier fallo se loguea y devuelve `{ sent:false }` — el cron no
 * debe romperse por un pedido.
 */
export async function sendDeliverySurvey(opts: {
  sb: SupabaseClient;
  orderId: string;
  phone: string;
  /**
   * Empresa del pedido (multi-empresa). OPCIONAL y retrocompatible (mismo patrón
   * que `lib/orders/rewards.ts`): cuando se pasa, settings/chats/order_surveys se
   * scopean por `company_id` y el `chats.id` toma el formato
   * `wa:<companyId>:<phone>` (vía `chatIdFor`). Sin él, comportamiento legacy
   * (settings id=1, chat `wa:<phone>`). NOTA: `sendSurvey` vive en `lib/bot/**`
   * y aún no es consciente de empresa (no se edita en esta tarea); usa el env
   * Kapso global. Cuando el bot se migre, propagar companyId hasta él.
   */
  companyId?: string;
}): Promise<DeliverySurveyResult> {
  const { sb, orderId, phone, companyId } = opts;
  try {
    // Respetar el switch de la UI (Configuración → Reseñas).
    let settingsQuery = sb.from('settings').select('survey_enabled, survey_min_days');
    settingsQuery = companyId ? settingsQuery.eq('company_id', companyId) : settingsQuery.eq('id', 1);
    const { data: settings } = await settingsQuery.maybeSingle();
    if ((settings?.survey_enabled ?? true) === false) return { sent: false, skipped: 'disabled' };

    // No interrumpir si el chat lo atiende un humano, ni si el cliente está a
    // mitad de otro flujo (registro/dirección/otra encuesta en curso).
    const chatId = chatIdFor(companyId, phone);
    let chatQuery = sb.from('chats').select('status, flow_state').eq('id', chatId);
    if (companyId) chatQuery = chatQuery.eq('company_id', companyId);
    const { data: chat } = await chatQuery.maybeSingle();
    if ((chat?.status as string | undefined) === 'human') return { sent: false, skipped: 'human' };
    const step = (chat?.flow_state as { step?: string } | null)?.step;
    if (step && !QUIET_STEPS.has(step)) return { sent: false, skipped: `step:${step}` };

    // No re-encuestar al cliente si ya recibió una encuesta hace poco
    // (survey_min_days). 0 = sin límite. Evita molestar al recurrente.
    const minDays = (settings as { survey_min_days?: number } | null)?.survey_min_days ?? 30;
    if (minDays > 0) {
      const since = new Date(Date.now() - minDays * 86_400_000).toISOString();
      let recentQuery = sb
        .from('order_surveys')
        .select('id')
        .eq('phone', phone)
        .gte('sent_at', since);
      if (companyId) recentQuery = recentQuery.eq('company_id', companyId);
      const { data: recent } = await recentQuery.limit(1);
      if (recent && recent.length > 0) return { sent: false, skipped: 'min_days' };
    }

    await sendSurvey({ phone, orderId, companyId });

    // Registrar la encuesta (el rating se llena cuando el cliente responde).
    // `order_id` es UNIQUE → el upsert hace idempotente el reenvío.
    await sb
      .from('order_surveys')
      .upsert(
        {
          order_id: orderId,
          phone,
          sent_at: new Date().toISOString(),
          ...(companyId ? { company_id: companyId } : {}),
        },
        { onConflict: 'order_id' },
      );

    // Dejar el chat esperando la calificación (1–5).
    await saveFlowState(chatId, { step: 'postventa_encuesta', surveyOrderId: orderId });
    return { sent: true };
  } catch (err) {
    console.error('[sendDeliverySurvey] error', { orderId, err });
    return { sent: false, skipped: 'error' };
  }
}

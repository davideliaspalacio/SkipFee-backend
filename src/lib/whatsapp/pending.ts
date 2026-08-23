/**
 * Persistencia de las opciones de un menú degradado (`chats.pending_options`).
 *
 * Vive en su propia columna, NO dentro de `flow_state`, a propósito:
 * `processFlowMessage` hace loadFlowState → routeFlow → saveFlowState, y los
 * envíos ocurren dentro de routeFlow. Si el adaptador escribiera en flow_state,
 * el saveFlowState posterior lo pisaría con el estado calculado antes del envío.
 * Columna aparte = ciclo de vida propio = sin carrera.
 */

import { supabaseAdmin } from '@/lib/db';
import type { PendingOptions } from './degrade';

/**
 * Guarda las opciones ofrecidas en el último menú degradado del chat.
 * Best-effort: si falla, se loguea y sigue. Un menú sin mapeo de vuelta
 * degrada a "el bot no entiende y repregunta", que es recuperable; tumbar el
 * envío entero no lo es.
 */
export async function savePendingOptions(
  chatId: string,
  pending: PendingOptions,
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('chats')
    .update({ pending_options: pending as never })
    .eq('id', chatId);
  if (error) {
    console.error('[whatsapp] no se pudieron guardar pending_options', {
      chatId,
      error,
    });
  }
}

/** Lee las opciones pendientes de un chat (null si no hay). */
export async function loadPendingOptions(
  chatId: string,
): Promise<PendingOptions | null> {
  const { data, error } = await supabaseAdmin()
    .from('chats')
    .select('pending_options')
    .eq('id', chatId)
    .maybeSingle();
  if (error || !data) return null;
  const raw = data.pending_options as PendingOptions | null;
  if (!raw?.options?.length) return null;
  return raw;
}

/**
 * Limpia las opciones pendientes. Se llama tras procesar CUALQUIER mensaje
 * entrante: el menú se consume una sola vez, matchee o no. Si no limpiáramos,
 * un "1" escrito tres pasos después reactivaría una opción vieja.
 */
export async function clearPendingOptions(chatId: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('chats')
    .update({ pending_options: null })
    .eq('id', chatId);
  if (error) {
    console.error('[whatsapp] no se pudieron limpiar pending_options', {
      chatId,
      error,
    });
  }
}

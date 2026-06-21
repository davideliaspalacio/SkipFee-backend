import { supabaseAdmin } from './db';

function hhmm(date = new Date()): string {
  return date.toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Construye el `chats.id` de un teléfono.
 *
 * Multi-empresa: cuando hay `companyId`, el id es `wa:<companyId>:<phone>` para
 * que el mismo número en empresas distintas sea un chat distinto. Cuando no
 * (callers legacy aún sin migrar), conserva el formato single-tenant `wa:<phone>`.
 */
export function chatIdFor(companyId: string | null | undefined, phone: string): string {
  return companyId ? `wa:${companyId}:${phone}` : `wa:${phone}`;
}

/**
 * Persiste un mensaje (entrante o saliente). Si el chat no existe, lo crea
 * con valores por defecto. Actualiza last/time/last_message_at del chat.
 *
 * Multi-empresa: `companyId` es OPCIONAL. Cuando se pasa, `chats.id` toma el
 * formato `wa:<companyId>:<phone>` y tanto `chats` como `messages` llevan
 * `company_id`. Cuando NO se pasa (rutas/bot aún sin migrar), mantiene el
 * comportamiento legacy (`wa:<phone>`, sin `company_id`) para no romper el build.
 */
export async function recordMessage(opts: {
  phone: string;
  direction: 'in' | 'out' | 'bot';
  body: string;
  kapsoMessageId?: string | null;
  name?: string;
  mediaUrl?: string | null;
  companyId?: string;
}): Promise<{ chatId: string }> {
  const { companyId } = opts;
  const chatId = chatIdFor(companyId, opts.phone);
  const nowIso = new Date().toISOString();
  const sb = supabaseAdmin();

  // 1. Asegurar chat (insert si no existe; no toca si existe)
  const { error: insertChatError } = await sb.from('chats').upsert(
    {
      id: chatId,
      phone: opts.phone,
      name: opts.name ?? opts.phone,
      status: 'bot',
      ...(companyId ? { company_id: companyId } : {}),
    },
    { onConflict: 'id', ignoreDuplicates: true },
  );
  if (insertChatError) throw insertChatError;

  // 2. Actualizar campos que cambian con cada mensaje. Para imágenes sin
  // caption mostramos "📷 Imagen" como preview en la lista de chats.
  const previewBase = opts.body.trim().length > 0
    ? opts.body
    : opts.mediaUrl
      ? '📷 Imagen'
      : '';
  const { error: updateChatError } = await sb
    .from('chats')
    .update({
      last: previewBase.slice(0, 200),
      time: hhmm(),
      last_message_at: nowIso,
    })
    .eq('id', chatId);
  if (updateChatError) throw updateChatError;

  // 3. Insertar mensaje
  const { error: insertMsgError } = await sb.from('messages').insert({
    chat_id: chatId,
    direction: opts.direction,
    body: opts.body,
    kapso_message_id: opts.kapsoMessageId ?? null,
    media_url: opts.mediaUrl ?? null,
    ...(companyId ? { company_id: companyId } : {}),
  });
  if (insertMsgError) throw insertMsgError;

  return { chatId };
}

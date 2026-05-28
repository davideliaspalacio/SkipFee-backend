import { supabaseAdmin } from './db';

function hhmm(date = new Date()): string {
  return date.toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Persiste un mensaje (entrante o saliente). Si el chat no existe, lo crea
 * con valores por defecto. Actualiza last/time/last_message_at del chat.
 */
export async function recordMessage(opts: {
  phone: string;
  direction: 'in' | 'out' | 'bot';
  body: string;
  kapsoMessageId?: string | null;
  name?: string;
}): Promise<{ chatId: string }> {
  const chatId = `wa:${opts.phone}`;
  const nowIso = new Date().toISOString();
  const sb = supabaseAdmin();

  // 1. Asegurar chat (insert si no existe; no toca si existe)
  const { error: insertChatError } = await sb.from('chats').upsert(
    {
      id: chatId,
      phone: opts.phone,
      name: opts.name ?? opts.phone,
      status: 'bot',
    },
    { onConflict: 'id', ignoreDuplicates: true },
  );
  if (insertChatError) throw insertChatError;

  // 2. Actualizar campos que cambian con cada mensaje
  const { error: updateChatError } = await sb
    .from('chats')
    .update({
      last: opts.body.slice(0, 200),
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
  });
  if (insertMsgError) throw insertMsgError;

  return { chatId };
}

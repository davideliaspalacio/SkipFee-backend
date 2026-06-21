import { z } from 'zod';
import { sendImage, sendText } from '@/lib/kapso/client';
import { serializeMessage } from '@/lib/serializers';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/<companyId>/chats/:id/messages?limit=
 * Devuelve los mensajes del chat (de LA empresa) ordenados por created_at
 * ascendente (en el chat se muestran de viejos a nuevos).
 *
 * `:id` es el id de chat en formato `wa:<companyId>:<phone>`. Filtramos además
 * por `company_id` (capa 1) para que un id de otra empresa no devuelva nada.
 */
export const GET = withTenant<{ companyId: string; id: string }>(async (request, ctx, params) => {
  const { id } = params;
  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 200, 500) : 200;

  const { data, error } = await ctx.db
    .from('messages')
    .select('direction, body, media_url, created_at')
    .eq('company_id', ctx.company.id)
    .eq('chat_id', id)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[chats/messages GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const messages = (data ?? []).map(serializeMessage);
  return Response.json({ ok: true, messages });
});

// Acepta texto, imagen, o imagen con caption. Si viene imageUrl, body es la
// caption opcional; si no, body es obligatorio.
const bodySchema = z
  .object({
    body: z.string().max(4096).optional(),
    imageUrl: z.string().url().optional(),
  })
  .refine(
    v => (v.body && v.body.trim().length > 0) || (v.imageUrl && v.imageUrl.length > 0),
    { message: 'Debes enviar body o imageUrl' },
  );

function hhmm(date = new Date()): string {
  return date.toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * POST /api/<companyId>/chats/:id/messages
 * El operario responde al cliente desde el panel:
 * 1. Resuelve el chat de LA empresa (necesita phone para sendText).
 * 2. Envía vía Kapso.
 * 3. Persiste el mensaje saliente con kapsoMessageId, scopeado por empresa.
 *
 * Nota: este endpoint NO toca chat.status. Se asume que el operario ya tomó
 * la conversación con POST /takeover; si no lo hizo, el bot puede seguir respondiendo
 * y los mensajes se intercalan. El frontend debe forzar takeover antes de habilitar
 * la caja de escritura.
 */
export const POST = withTenant<{ companyId: string; id: string }>(async (request, ctx, params) => {
  const { id } = params;

  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const sb = ctx.db;
  const companyId = ctx.company.id;

  // 1. Cargar phone del chat (de la empresa)
  const { data: chat, error: getErr } = await sb
    .from('chats')
    .select('id, phone, status')
    .eq('company_id', companyId)
    .eq('id', id)
    .single();

  if (getErr || !chat) {
    return Response.json({ ok: false, error: 'Chat no encontrado' }, { status: 404 });
  }

  // 2. Enviar vía Kapso (imagen si vino imageUrl, si no texto)
  const caption = parsed.body?.trim() ?? '';
  let result;
  try {
    result = parsed.imageUrl
      ? await sendImage(chat.phone, parsed.imageUrl, caption || undefined)
      : await sendText(chat.phone, caption);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[chats/messages] Kapso error', err);
    return Response.json({ ok: false, error: message }, { status: 502 });
  }

  // 3. Persistir saliente, scopeado por empresa. Lo hacemos inline (no vía
  //    recordMessage, que es helper compartido aún en formato single-tenant
  //    `wa:<phone>` y sin company_id) para mantener el id y company_id correctos.
  const wamid = result.messages?.[0]?.id ?? null;
  const nowIso = new Date().toISOString();
  const mediaUrl = parsed.imageUrl ?? null;
  const previewBase = caption.length > 0 ? caption : mediaUrl ? '📷 Imagen' : '';
  try {
    await sb
      .from('chats')
      .update({ last: previewBase.slice(0, 200), time: hhmm(), last_message_at: nowIso })
      .eq('company_id', companyId)
      .eq('id', chat.id);

    const { error: insertMsgError } = await sb.from('messages').insert({
      company_id: companyId,
      chat_id: chat.id,
      direction: 'out',
      body: caption,
      kapso_message_id: wamid,
      media_url: mediaUrl,
    });
    if (insertMsgError) throw insertMsgError;
  } catch (err) {
    console.error('[chats/messages] persistence error (mensaje sí se envió)', err);
  }

  return Response.json({ ok: true, chatId: chat.id, wamid });
});

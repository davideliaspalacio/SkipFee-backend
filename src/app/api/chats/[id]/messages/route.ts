import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { sendText } from '@/lib/kapso/client';
import { recordMessage } from '@/lib/messaging';
import { serializeMessage } from '@/lib/serializers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/chats/:id/messages?limit=
 * Devuelve los mensajes del chat ordenados por created_at ascendente
 * (en el chat se muestran de viejos a nuevos).
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 200, 500) : 200;

  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('direction, body, created_at')
    .eq('chat_id', id)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[chats/messages GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const messages = (data ?? []).map(serializeMessage);
  return Response.json({ ok: true, messages });
}

const bodySchema = z.object({
  body: z.string().min(1).max(4096),
});

/**
 * POST /api/chats/:id/messages
 * El operario responde al cliente desde el panel:
 * 1. Resuelve el chat (necesita phone para sendText).
 * 2. Envía vía Kapso.
 * 3. Persiste el mensaje saliente con kapsoMessageId.
 *
 * Nota: este endpoint NO toca chat.status. Se asume que el operario ya tomó
 * la conversación con POST /takeover; si no lo hizo, el bot puede seguir respondiendo
 * y los mensajes se intercalan. El frontend debe forzar takeover antes de habilitar
 * la caja de escritura.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const sb = supabaseAdmin();

  // 1. Cargar phone del chat
  const { data: chat, error: getErr } = await sb
    .from('chats')
    .select('id, phone, status')
    .eq('id', id)
    .single();

  if (getErr || !chat) {
    return Response.json({ ok: false, error: 'Chat no encontrado' }, { status: 404 });
  }

  // 2. Enviar vía Kapso
  let result;
  try {
    result = await sendText(chat.phone, parsed.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[chats/messages] Kapso error', err);
    return Response.json({ ok: false, error: message }, { status: 502 });
  }

  // 3. Persistir saliente
  const wamid = result.messages?.[0]?.id ?? null;
  try {
    await recordMessage({
      phone: chat.phone,
      direction: 'out',
      body: parsed.body,
      kapsoMessageId: wamid,
    });
  } catch (err) {
    console.error('[chats/messages] persistence error (mensaje sí se envió)', err);
  }

  return Response.json({ ok: true, chatId: chat.id, wamid });
}

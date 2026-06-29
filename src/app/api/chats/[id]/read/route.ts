import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/chats/:id/read
 * Marca la conversación como leída para el operador del dashboard.
 *
 * Fuente de verdad:
 * - chats.unread = contador que alimenta badges/lista.
 * - messages.read_at en direction='in' = auditoría de qué mensajes entrantes
 *   ya fueron vistos por alguien en el panel.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const sb = supabaseAdmin();

  const { data: chat, error: getErr } = await sb
    .from('chats')
    .select('id')
    .eq('id', id)
    .single();

  if (getErr) {
    const notFound = getErr.code === 'PGRST116';
    if (!notFound) console.error('[chats/read GET] error', getErr);
    return Response.json(
      { ok: false, error: notFound ? 'Chat no encontrado' : getErr.message },
      { status: notFound ? 404 : 500 },
    );
  }
  if (!chat) {
    return Response.json({ ok: false, error: 'Chat no encontrado' }, { status: 404 });
  }

  const now = new Date().toISOString();
  const { error: messagesErr } = await sb
    .from('messages')
    .update({ read_at: now })
    .eq('chat_id', id)
    .eq('direction', 'in')
    .is('read_at', null);

  if (messagesErr) {
    console.error('[chats/read messages] error', messagesErr);
    return Response.json({ ok: false, error: messagesErr.message }, { status: 500 });
  }

  const { data, error } = await sb
    .from('chats')
    .update({ unread: 0 })
    .eq('id', id)
    .select('id, unread')
    .single();

  if (error || !data) {
    console.error('[chats/read update] error', error);
    return Response.json(
      { ok: false, error: error?.message ?? 'Chat no encontrado' },
      { status: error?.code === 'PGRST116' ? 404 : 500 },
    );
  }

  return Response.json({ ok: true, chatId: data.id, unread: data.unread });
}

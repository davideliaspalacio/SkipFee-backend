import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/chats/stats
 * Contadores ligeros para el header de WhatsApp + el badge del sidebar:
 *   - total:   todos los chats en la tabla
 *   - pending: chats esperando atención humana (chat_status='pending')
 *   - unread:  chats con al menos un mensaje sin leer (unread > 0).
 *              Es lo que usa el badge del sidebar: "hay actividad nueva".
 *
 * Una sola query con `select('status, unread')` y agregamos en memoria — el
 * dataset es acotado (200-500 chats típicamente).
 */
export async function GET() {
  const sb = supabaseAdmin();

  const { data, error } = await sb.from('chats').select('status, unread');

  if (error) {
    console.error('[chats/stats GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{ status: string; unread: number }>;
  const total = rows.length;
  let pending = 0;
  let unread = 0;
  for (const r of rows) {
    if (r.status === 'pending') pending += 1;
    if ((r.unread ?? 0) > 0) unread += 1;
  }

  return Response.json({ ok: true, total, pending, unread });
}

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { chatStatsByPhone } from '@/lib/chat-stats';
import { serializeChat } from '@/lib/serializers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/chats?status=bot|human|pending
 * Lista chats ordenados por última actividad (más reciente primero).
 * prevOrders/avgTicket se calculan on-the-fly desde `orders` (entregados)
 * agrupando por teléfono; las columnas homónimas en `chats` quedaron sin uso.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');

  let query = supabaseAdmin()
    .from('chats')
    .select('id, name, phone, last, time, unread, status, zone_id, last_message_at')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(200);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) {
    console.error('[chats GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = data ?? [];
  const stats = await chatStatsByPhone(rows.map(r => r.phone));
  const chats = rows.map(r => serializeChat(r, stats.get(r.phone)));
  return Response.json({ ok: true, chats });
}

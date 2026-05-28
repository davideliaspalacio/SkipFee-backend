import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { serializeChat } from '@/lib/serializers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/chats?status=bot|human|pending
 * Lista chats ordenados por última actividad (más reciente primero).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');

  let query = supabaseAdmin()
    .from('chats')
    .select(
      'id, name, phone, last, time, unread, status, zone_id, prev_orders, avg_ticket, last_message_at',
    )
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(200);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) {
    console.error('[chats GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const chats = (data ?? []).map(serializeChat);
  return Response.json({ ok: true, chats });
}

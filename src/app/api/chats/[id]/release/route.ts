import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/chats/:id/release
 * Devuelve el chat al bot (status='bot'). Lo usa el operario al terminar de
 * atender un caso atípico desde el panel.
 */
export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const sb = supabaseAdmin();

  const { data, error } = await sb
    .from('chats')
    .update({ status: 'bot' })
    .eq('id', id)
    .select('id, status')
    .single();

  if (error || !data) {
    return Response.json({ ok: false, error: 'Chat no encontrado' }, { status: 404 });
  }

  return Response.json({ ok: true, chatId: data.id, status: data.status });
}

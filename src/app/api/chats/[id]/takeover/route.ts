import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/chats/:id/takeover
 * Pone el chat en status='human'. El bot Kapso debe respetar este flag y dejar
 * de responder automáticamente (la lógica de skip vive en el Workflow Kapso).
 *
 * Idempotente: si ya está en 'human', devuelve 200 sin cambio.
 */
export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const sb = supabaseAdmin();

  const { data, error } = await sb
    .from('chats')
    .update({ status: 'human' })
    .eq('id', id)
    .select('id, status')
    .single();

  if (error || !data) {
    return Response.json({ ok: false, error: 'Chat no encontrado' }, { status: 404 });
  }

  return Response.json({ ok: true, chatId: data.id, status: data.status });
}

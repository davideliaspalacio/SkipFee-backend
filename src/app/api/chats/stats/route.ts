import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/chats/stats
 * Contadores ligeros para el header de WhatsApp:
 *   - total:   todos los chats en la tabla
 *   - pending: chats esperando atención humana (chat_status='pending')
 *
 * Una sola query con `select('status')` y agregamos en memoria — el dataset es
 * acotado (200-500 chats típicamente) y así reusamos el mismo patrón que
 * /api/orders/stats sin pedirle al stub de tests que soporte head:true counts.
 */
export async function GET() {
  const sb = supabaseAdmin();

  const { data, error } = await sb.from('chats').select('status');

  if (error) {
    console.error('[chats/stats GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{ status: string }>;
  const total = rows.length;
  const pending = rows.reduce((n, r) => (r.status === 'pending' ? n + 1 : n), 0);

  return Response.json({ ok: true, total, pending });
}

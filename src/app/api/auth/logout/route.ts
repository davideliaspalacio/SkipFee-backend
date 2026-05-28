import { buildClearCookies } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/logout
 * Borra las cookies de sesión. Idempotente — si no había sesión, igual ok.
 *
 * No invalidamos el refresh_token en Supabase porque eso requiere el cliente
 * con la sesión activa; en cambio, al borrar la cookie del browser ya no se
 * puede usar. Si quisiéramos invalidación dura, llamaríamos signOut con el
 * token actual antes de borrar.
 */
export async function POST() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: [
      ['Content-Type', 'application/json'],
      ...buildClearCookies().map(c => ['Set-Cookie', c] as [string, string]),
    ],
  });
}

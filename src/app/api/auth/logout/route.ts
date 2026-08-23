import type { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { buildClearCookies, REFRESH_COOKIE_NAME, SESSION_COOKIE_NAME } from '@/lib/auth';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/logout
 *
 * Borra las cookies de sesión Y **revoca el refresh token en Supabase**.
 *
 * Antes solo borraba las cookies. El problema: el panel guarda el access token
 * en `localStorage` (para el fetch cross-origin), así que un token exfiltrado de
 * ahí seguía sirviendo hasta 30 días aunque el usuario hubiera cerrado sesión.
 * Con registro autoservicio eso deja de ser un detalle.
 *
 * Sigue siendo idempotente: si no había sesión, o si la revocación falla, se
 * limpian las cookies igual y se responde 200. Cerrar sesión nunca debe fallar.
 */
export async function POST(request: NextRequest) {
  const accessToken =
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    request.cookies.get(SESSION_COOKIE_NAME)?.value ??
    null;
  const refreshToken = request.cookies.get(REFRESH_COOKIE_NAME)?.value ?? null;

  if (accessToken) {
    try {
      // `signOut` necesita una sesión activa en el cliente; la inyectamos con
      // los tokens que trae la petición y luego revocamos.
      const sb = createClient(
        env.NEXT_PUBLIC_SUPABASE_URL,
        env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
      if (refreshToken) {
        await sb.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      }
      await sb.auth.signOut();
    } catch (err) {
      // Best-effort: si Supabase no responde, igual limpiamos las cookies.
      console.error('[logout] no se pudo revocar el refresh token', err);
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: [
      ['Content-Type', 'application/json'],
      ...buildClearCookies().map(c => ['Set-Cookie', c] as [string, string]),
    ],
  });
}

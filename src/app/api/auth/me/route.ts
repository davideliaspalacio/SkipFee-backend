import type { NextRequest } from 'next/server';
import { buildSessionCookies, getSessionUser } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/me
 * Devuelve el usuario de la sesión actual o 401.
 * Si el access_token estaba vencido y se refrescó con el refresh_token,
 * actualiza las cookies en la respuesta.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return Response.json({ ok: false, error: 'No autenticado' }, { status: 401 });
  }

  const headers: Array<[string, string]> = [['Content-Type', 'application/json']];
  if (session.refreshedTokens) {
    for (const c of buildSessionCookies(session.refreshedTokens)) {
      headers.push(['Set-Cookie', c]);
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      user: {
        id: session.user.id,
        email: session.user.email,
        role: (session.user.app_metadata as { role?: string } | undefined)?.role ?? null,
      },
    }),
    { status: 200, headers },
  );
}

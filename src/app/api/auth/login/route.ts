import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { authClient, buildSessionCookies } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Valida con Supabase Auth. Si OK setea cookies bs_session + bs_refresh
 * y devuelve { user }. Si falla devuelve 401.
 *
 * Las cookies son HTTP-only: el frontend NO puede leerlas, solo las manda
 * automáticamente con fetch credentials:include.
 */
export async function POST(request: NextRequest) {
  let body;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const supabase = authClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: body.email,
    password: body.password,
  });

  if (error || !data.session || !data.user) {
    // No revelamos si fue email inexistente vs password incorrecta.
    return Response.json(
      { ok: false, error: 'Email o contraseña incorrectos' },
      { status: 401 },
    );
  }

  const cookies = buildSessionCookies({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      user: {
        id: data.user.id,
        email: data.user.email,
        role: (data.user.app_metadata as { role?: string } | undefined)?.role ?? null,
      },
      // Devolvemos también los tokens en el body para que el frontend
      // cross-origin los guarde en localStorage y los mande en el header
      // Authorization. En same-origin las cookies bs_session ya bastan.
      session: {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at,
      },
    }),
    {
      status: 200,
      headers: [
        ['Content-Type', 'application/json'],
        ...cookies.map(c => ['Set-Cookie', c] as [string, string]),
      ],
    },
  );
}

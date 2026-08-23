import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { authClient, buildSessionCookies } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/redeem — canjea un pase de un solo uso por una sesión.
 *
 * Para qué: al terminar el registro en la landing, el dueño ya escribió su
 * contraseña hace diez segundos. Mandarlo a un login a escribirla otra vez es
 * una puerta cerrada en el único momento en que tenemos toda su atención. El
 * alta emite un pase, la landing lo lleva en la URL hacia el panel, y el panel
 * lo canjea aquí por una sesión real.
 *
 * Por qué un pase y no los tokens directamente: lo que viaja por la URL queda en
 * el historial del navegador. Un `access_token` ahí sigue sirviendo durante una
 * hora; este pase **muere al primer uso** y expira solo. Si alguien lo lee del
 * historial, ya no vale nada.
 *
 * El pase es el `hashed_token` de un magiclink de Supabase generado con
 * `generateLink` — que NO envía correo, solo lo emite. Así el de un solo uso, el
 * vencimiento y la invalidación los maneja Supabase, sin tabla propia que
 * mantener ni limpiar.
 */

const bodySchema = z.object({
  token: z.string().min(20).max(500),
});

export async function POST(request: NextRequest) {
  let body;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return Response.json({ ok: false, error: 'Pase inválido' }, { status: 400 });
  }

  const supabase = authClient();
  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: body.token,
    type: 'magiclink',
  });

  if (error || !data.session || !data.user) {
    // Un pase ya usado o vencido llega acá. El mensaje evita el "algo salió
    // mal": lo que hay que hacer es entrar con la contraseña, no reintentar.
    return Response.json(
      { ok: false, error: 'Este enlace ya se usó o venció. Entra con tu correo y contraseña.' },
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

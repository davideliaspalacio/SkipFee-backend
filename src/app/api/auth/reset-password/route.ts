import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/reset-password — fija la contraseña nueva.
 *
 * El correo de recuperación devuelve al usuario al panel con un `access_token`
 * de un solo uso. El panel lo manda acá junto con la contraseña nueva.
 *
 * Se usa la publishable key (no `service_role`): el token del correo ES la
 * autorización. Con service_role podríamos cambiarle la contraseña a cualquiera
 * sin prueba de identidad.
 */

const schema = z.object({
  accessToken: z.string().min(10),
  password: z.string().min(8).max(72),
});

export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'La contraseña debe tener al menos 8 caracteres.' },
      { status: 400 },
    );
  }

  const sb = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${parsed.data.accessToken}` } },
    },
  );

  const { error } = await sb.auth.updateUser({ password: parsed.data.password });

  if (error) {
    console.error('[reset-password] error', error.message);
    return Response.json(
      { ok: false, error: 'El enlace venció o ya se usó. Pide uno nuevo.' },
      { status: 400 },
    );
  }

  return Response.json({ ok: true });
}

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { authClient } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/forgot-password — pide el correo de recuperación.
 *
 * Hasta ahora no existía: la pantalla de login decía literalmente *"Pídele al
 * admin que la reestablezca"*. Con alta asistida eso era un mensaje a Skipfee;
 * con registro autoservicio, cada olvido sería un ticket que nadie puede
 * atender.
 *
 * ⚠️ Responde `ok: true` SIEMPRE, exista el correo o no. Si distinguiéramos,
 * cualquiera podría averiguar qué correos tienen cuenta en Skipfee probando
 * uno por uno.
 */

const schema = z.object({ email: z.string().email().max(200) });

export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'Correo inválido' }, { status: 400 });
  }

  // A dónde vuelve el usuario tras hacer clic en el correo. Es el panel, no el
  // backend: ahí está la pantalla que pide la contraseña nueva.
  const panelOrigin =
    process.env.PANEL_ORIGIN ??
    process.env.EXTRA_CORS_ORIGINS?.split(',')[0]?.trim() ??
    'http://localhost:3001';

  try {
    await authClient().auth.resetPasswordForEmail(parsed.data.email, {
      redirectTo: `${panelOrigin.replace(/\/+$/, '')}/reset-password`,
    });
  } catch (err) {
    // Tampoco acá revelamos nada: se loguea y se responde igual que en el
    // camino feliz.
    console.error('[forgot-password] error enviando el correo', err);
  }

  return Response.json({
    ok: true,
    message: 'Si ese correo tiene una cuenta, le llegará un enlace para crear una contraseña nueva.',
  });
}

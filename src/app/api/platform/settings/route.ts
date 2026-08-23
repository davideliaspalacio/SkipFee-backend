import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { requirePlatformAdmin } from '@/lib/tenant';
import { olvidarPlatformSettings, platformSettings } from '@/lib/trial';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/platform/settings — configuración de la plataforma (solo owner).
 *
 * Hoy: días de prueba y qué pasa al vencer. Es la palanca que pidió el negocio:
 * "un solo número que se cambia y los trials nuevos duran eso".
 *
 * Cambiarlo NO reescribe los relojes ya corriendo. Mover la meta a alguien que
 * está en mitad de su prueba es la clase de sorpresa que hace que un negocio se
 * vaya; para casos puntuales existe extender el trial de UNA empresa desde su
 * ficha (PATCH /api/platform/companies/:id).
 */

const patchSchema = z.object({
  trialDays: z.number().int().min(1).max(365).optional(),
  alVencer: z.enum(['bloquear', 'avisar']).optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requirePlatformAdmin(request);
  if ('error' in auth) {
    return Response.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const settings = await platformSettings();
  return Response.json({ ok: true, settings });
}

export async function PATCH(request: NextRequest) {
  const auth = await requirePlatformAdmin(request);
  if ('error' in auth) {
    return Response.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  let body;
  try {
    body = patchSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if (body.trialDays !== undefined) update.trial_days = body.trialDays;
  if (body.alVencer !== undefined) update.al_vencer = body.alVencer;

  if (Object.keys(update).length === 0) {
    return Response.json({ ok: false, error: 'Nada que actualizar' }, { status: 400 });
  }

  const { error } = await supabaseAdmin()
    .from('platform_settings')
    .update(update)
    .eq('id', 1);

  if (error) {
    console.error('[platform/settings] update error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  olvidarPlatformSettings();
  return Response.json({ ok: true, settings: await platformSettings() });
}

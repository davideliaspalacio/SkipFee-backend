import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/zones/[id]
 * Edita campos de una zona (tarifa, recargo, color, coordenadas).
 * El nombre lo mantenemos fijo para no romper referencias en pedidos
 * existentes; si hace falta cambiarlo, se hace por SQL admin.
 */
const patchSchema = z.object({
  tarifa: z.number().int().nonnegative().optional(),
  recargo: z.number().int().nonnegative().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  let body;
  try {
    body = patchSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  if (Object.keys(body).length === 0) {
    return Response.json({ ok: false, error: 'Nada que actualizar' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin()
    .from('zones')
    .update(body)
    .eq('id', id)
    .select('id, name, tarifa, recargo, color, lat, lng')
    .single();

  if (error || !data) {
    return Response.json({ ok: false, error: error?.message ?? 'Zona no encontrada' }, { status: 404 });
  }

  return Response.json({ ok: true, zone: data });
}

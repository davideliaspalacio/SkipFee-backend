import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SELECT = 'id, name, tarifa, recargo, color, lat, lng, archived';

/**
 * PATCH /api/zones/[id] — edita una zona.
 *
 * `name` SÍ es editable: las referencias (orders/customers/chats) son por `id`,
 * que no cambia. `recargo` se mantiene en el schema por compat pero ya no se usa
 * (hora pico eliminada).
 */
const patchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  tarifa: z.number().int().nonnegative().optional(),
  recargo: z.number().int().nonnegative().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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
    .select(SELECT)
    .single();

  if (error || !data) {
    return Response.json({ ok: false, error: error?.message ?? 'Zona no encontrada' }, { status: 404 });
  }
  return Response.json({ ok: true, zone: data });
}

/**
 * DELETE /api/zones/[id] — archiva la zona (soft-delete). No borra físicamente
 * porque hay FK desde pedidos/clientes. El bot/admin dejan de ofrecerla.
 */
export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const { data, error } = await supabaseAdmin()
    .from('zones')
    .update({ archived: true })
    .eq('id', id)
    .select('id')
    .single();

  if (error || !data) {
    return Response.json({ ok: false, error: error?.message ?? 'Zona no encontrada' }, { status: 404 });
  }
  return Response.json({ ok: true });
}

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { hoursSchema } from '@/lib/hours-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SELECT = 'id, name, hours, archived, created_at';

/**
 * PATCH /api/cooks/[id] — edita nombre, horario o estado (archivar).
 */
const patchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  hours: hoursSchema.optional(),
  archived: z.boolean().optional(), // archivar (true) / desarchivar (false)
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
    .from('cooks')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(SELECT)
    .single();

  if (error || !data) {
    return Response.json(
      { ok: false, error: error?.message ?? 'Cocinero no encontrado' },
      { status: 404 },
    );
  }
  return Response.json({ ok: true, cook: data });
}

/**
 * DELETE /api/cooks/[id] — archiva el cocinero (soft-delete). No se borra
 * físicamente porque `orders.cook_id` lo referencia; los pedidos viejos
 * conservan su cocinero. Deja de recibir asignaciones nuevas.
 */
export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const { data, error } = await supabaseAdmin()
    .from('cooks')
    .update({ archived: true, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id')
    .single();

  if (error || !data) {
    return Response.json(
      { ok: false, error: error?.message ?? 'Cocinero no encontrado' },
      { status: 404 },
    );
  }
  return Response.json({ ok: true });
}

import { z } from 'zod';
import { hoursSchema } from '@/lib/hours-schema';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SELECT = 'id, name, hours, archived, created_at';

/**
 * PATCH /api/<companyId>/cooks/[id] — edita nombre, horario o estado (archivar).
 */
const patchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  hours: hoursSchema.optional(),
  archived: z.boolean().optional(), // archivar (true) / desarchivar (false)
});

export const PATCH = withTenant<{ companyId: string; id: string }>(async (request, ctx, params) => {
  const { id } = params;

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

  const { data, error } = await ctx.db
    .from('cooks')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('company_id', ctx.company.id)
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
});

/**
 * DELETE /api/<companyId>/cooks/[id] — archiva el cocinero (soft-delete). No se
 * borra físicamente porque `orders.cook_id` lo referencia; los pedidos viejos
 * conservan su cocinero. Deja de recibir asignaciones nuevas.
 */
export const DELETE = withTenant<{ companyId: string; id: string }>(async (_request, ctx, params) => {
  const { id } = params;

  const { data, error } = await ctx.db
    .from('cooks')
    .update({ archived: true, updated_at: new Date().toISOString() })
    .eq('company_id', ctx.company.id)
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
});

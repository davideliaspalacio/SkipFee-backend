import { z } from 'zod';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SELECT = 'id, name, tarifa, recargo, color, lat, lng, archived, coverage, coverageRadiusM:coverage_radius_m';

/**
 * PATCH /api/<companyId>/zones/[id] — edita una zona de LA empresa.
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
  archived: z.boolean().optional(), // archivar (true) / desarchivar (false)
  coverage: z.array(z.object({ lat: z.number(), lng: z.number() })).min(3).nullable().optional(),
  coverageRadiusM: z.number().int().positive().nullable().optional(),
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

  // El frontend manda `coverageRadiusM` (camelCase); la columna es snake_case.
  const { coverageRadiusM, ...rest } = body;
  const dbPatch: Record<string, unknown> = { ...rest };
  if (coverageRadiusM !== undefined) dbPatch.coverage_radius_m = coverageRadiusM;

  const { data, error } = await ctx.db
    .from('zones')
    .update(dbPatch)
    .eq('company_id', ctx.company.id)
    .eq('id', id)
    .select(SELECT)
    .single();

  if (error || !data) {
    return Response.json({ ok: false, error: error?.message ?? 'Zona no encontrada' }, { status: 404 });
  }
  return Response.json({ ok: true, zone: data });
});

/**
 * DELETE /api/<companyId>/zones/[id] — archiva la zona (soft-delete) de LA
 * empresa. No borra físicamente porque hay FK desde pedidos/clientes. El
 * bot/admin dejan de ofrecerla.
 */
export const DELETE = withTenant<{ companyId: string; id: string }>(async (_request, ctx, params) => {
  const { id } = params;

  const { data, error } = await ctx.db
    .from('zones')
    .update({ archived: true })
    .eq('company_id', ctx.company.id)
    .eq('id', id)
    .select('id')
    .single();

  if (error || !data) {
    return Response.json({ ok: false, error: error?.message ?? 'Zona no encontrada' }, { status: 404 });
  }
  return Response.json({ ok: true });
});

import { z } from 'zod';
import { withTenant } from '@/lib/tenant';
import { TABLE_SELECT, serializeTable, type DiningTableRow } from '@/lib/dinein';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/<companyId>/tables/[id] — edita datos de la mesa, archiva/activa, o
 * regenera el QR (`regenerateQr: true` → nuevo `qr_token`, invalida el anterior).
 */
const patchSchema = z.object({
  code: z.string().min(1).max(20).optional(),
  label: z.string().max(60).nullable().optional(),
  area: z.string().max(60).nullable().optional(),
  seats: z.number().int().min(1).max(50).optional(),
  isActive: z.boolean().optional(),
  archived: z.boolean().optional(),
  regenerateQr: z.boolean().optional(),
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

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.code !== undefined) update.code = body.code;
  if (body.label !== undefined) update.label = body.label;
  if (body.area !== undefined) update.area = body.area;
  if (body.seats !== undefined) update.seats = body.seats;
  if (body.isActive !== undefined) update.is_active = body.isActive;
  if (body.archived !== undefined) update.archived = body.archived;
  if (body.regenerateQr) update.qr_token = crypto.randomUUID();

  if (Object.keys(update).length === 1) {
    return Response.json({ ok: false, error: 'Nada que actualizar' }, { status: 400 });
  }

  const { data, error } = await ctx.db
    .from('dining_tables')
    .update(update)
    .eq('company_id', ctx.company.id)
    .eq('id', id)
    .select(TABLE_SELECT)
    .single();

  if (error || !data) {
    const isDup = error?.code === '23505';
    return Response.json(
      { ok: false, error: isDup ? 'Ya existe una mesa con ese código' : error?.message ?? 'Mesa no encontrada' },
      { status: isDup ? 409 : 404 },
    );
  }
  return Response.json({ ok: true, table: serializeTable(data as unknown as DiningTableRow) });
});

/**
 * DELETE /api/<companyId>/tables/[id] — archiva la mesa (soft-delete). No se
 * borra físicamente porque `orders.table_id` la referencia; las cuentas viejas
 * conservan su mesa. Deja de aparecer en el salón.
 */
export const DELETE = withTenant<{ companyId: string; id: string }>(async (_request, ctx, params) => {
  const { id } = params;

  const { data, error } = await ctx.db
    .from('dining_tables')
    .update({ archived: true, updated_at: new Date().toISOString() })
    .eq('company_id', ctx.company.id)
    .eq('id', id)
    .select('id')
    .single();

  if (error || !data) {
    return Response.json({ ok: false, error: error?.message ?? 'Mesa no encontrada' }, { status: 404 });
  }
  return Response.json({ ok: true });
});

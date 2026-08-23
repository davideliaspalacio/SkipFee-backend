import { z } from 'zod';
import { withTenant } from '@/lib/tenant';
import { WAITER_SELECT, serializeWaiter, type WaiterRow } from '@/lib/dinein';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/<companyId>/waiters/[id] — edita nombre/teléfono o archiva/desarchiva.
 */
const patchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  phone: z.string().max(30).nullable().optional(),
  archived: z.boolean().optional(),
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
    .from('waiters')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('company_id', ctx.company.id)
    .eq('id', id)
    .select(WAITER_SELECT)
    .single();

  if (error || !data) {
    return Response.json(
      { ok: false, error: error?.message ?? 'Mesero no encontrado' },
      { status: 404 },
    );
  }
  return Response.json({ ok: true, waiter: serializeWaiter(data as unknown as WaiterRow) });
});

/**
 * DELETE /api/<companyId>/waiters/[id] — archiva el mesero (soft-delete). No se
 * borra físicamente porque `orders.waiter_id` lo referencia.
 */
export const DELETE = withTenant<{ companyId: string; id: string }>(async (_request, ctx, params) => {
  const { id } = params;

  const { data, error } = await ctx.db
    .from('waiters')
    .update({ archived: true, updated_at: new Date().toISOString() })
    .eq('company_id', ctx.company.id)
    .eq('id', id)
    .select('id')
    .single();

  if (error || !data) {
    return Response.json({ ok: false, error: error?.message ?? 'Mesero no encontrado' }, { status: 404 });
  }
  return Response.json({ ok: true });
});

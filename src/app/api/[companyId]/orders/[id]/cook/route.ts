import { z } from 'zod';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/<companyId>/orders/[id]/cook — reasignación MANUAL del cocinero de
 * un pedido (de LA empresa).
 *
 * Complementa la asignación automática al pagar (trigger de BD
 * `assign_cook_on_paid`, migración 0020): la operaria puede cambiar el cocinero
 * desde el detalle del pedido (alguien se fue, se enfermó, o quedó
 * desbalanceado). `cookId: null` lo deja sin asignar.
 */
const bodySchema = z.object({
  cookId: z.string().min(1).nullable(),
});

export const PATCH = withTenant<{ companyId: string; id: string }>(async (request, ctx, params) => {
  const { id } = params;

  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { data, error } = await ctx.db
    .from('orders')
    .update({ cook_id: parsed.cookId })
    .eq('company_id', ctx.company.id)
    .eq('id', id)
    .select('id, cook_id')
    .single();

  if (error || !data) {
    return Response.json(
      { ok: false, error: error?.message ?? 'Pedido no encontrado' },
      { status: 404 },
    );
  }
  return Response.json({ ok: true, orderId: id, cookId: parsed.cookId });
});

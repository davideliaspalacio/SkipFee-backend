import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/orders/[id]/cook — reasignación MANUAL del cocinero de un pedido.
 *
 * Complementa la asignación automática al pagar (trigger de BD
 * `assign_cook_on_paid`, migración 0020): la operaria puede cambiar el cocinero
 * desde el detalle del pedido (alguien se fue, se enfermó, o quedó
 * desbalanceado). `cookId: null` lo deja sin asignar.
 */
const bodySchema = z.object({
  cookId: z.string().min(1).nullable(),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin()
    .from('orders')
    .update({ cook_id: parsed.cookId })
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
}

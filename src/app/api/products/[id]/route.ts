import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  available: z.boolean().optional(),
  price: z.number().int().positive().optional(),
  name: z.string().min(1).max(120).optional(),
});

/**
 * PATCH /api/products/:id
 * Permite al operario toggle disponibilidad o cambiar precio/nombre desde Catálogo.
 * Solo campos provistos se actualizan.
 */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
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

  if (Object.keys(parsed).length === 0) {
    return Response.json({ ok: false, error: 'Sin campos para actualizar' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin()
    .from('products')
    .update(parsed)
    .eq('id', id)
    .select('id, name, price, cat, sold, available, img')
    .single();

  if (error || !data) {
    return Response.json({ ok: false, error: 'Producto no encontrado' }, { status: 404 });
  }

  return Response.json({ ok: true, product: data });
}

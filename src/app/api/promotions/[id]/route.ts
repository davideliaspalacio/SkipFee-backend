import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PATCH parcial: el operario puede activar/pausar, cambiar copy o ajustar el
// descuento sin pasar todo el form. `config` se permite reemplazar en bloque
// (más simple que diff por campo y suficiente para esta UI).
const patchSchema = z.object({
  kind: z.enum(['product', 'weekday']).optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  discount_type: z.enum(['percent', 'fixed', 'free_item', 'two_for_one']).optional(),
  discount_value: z.number().int().nonnegative().optional(),
  min_subtotal: z.number().int().nonnegative().optional(),
  config: z.object({
    product_ids: z.array(z.string().min(1)).optional(),
    weekdays: z.array(z.number().int().min(0).max(6)).optional(),
    starts_hhmm: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    ends_hhmm: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  }).optional(),
  active: z.boolean().optional(),
  archived: z.boolean().optional(),
  starts_at: z.string().datetime().nullable().optional(),
  ends_at: z.string().datetime().nullable().optional(),
});

/**
 * PATCH /api/promotions/:id
 * Edita una promoción existente. Solo campos provistos se actualizan.
 */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  let parsed;
  try {
    parsed = patchSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  if (Object.keys(parsed).length === 0) {
    return Response.json({ ok: false, error: 'Sin campos para actualizar' }, { status: 400 });
  }

  // Normalización: description='' ⇒ null (igual que en products).
  const patch =
    typeof parsed.description === 'string' && !parsed.description.trim()
      ? { ...parsed, description: null }
      : parsed;

  const { data, error } = await supabaseAdmin()
    .from('promotions')
    .update(patch)
    .eq('id', id)
    .select('id, kind, name, description, discount_type, discount_value, min_subtotal, config, active, archived, starts_at, ends_at, created_at, updated_at')
    .single();

  if (error || !data) {
    return Response.json({ ok: false, error: 'Promoción no encontrada' }, { status: 404 });
  }

  return Response.json({ ok: true, promotion: data });
}

/**
 * DELETE /api/promotions/:id
 * Soft-delete: marca la promoción como archivada (archived=true) y la desactiva
 * (active=false). Sale del admin, del storefront y del bot, pero conserva
 * `orders.promo_id` para no romper el FK ni el histórico. Para restaurar,
 * PATCH archived=false.
 */
export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const sb = supabaseAdmin();

  const { data, error } = await sb
    .from('promotions')
    .update({ archived: true, active: false })
    .eq('id', id)
    .select('id, kind, name, description, discount_type, discount_value, min_subtotal, config, active, archived, starts_at, ends_at, created_at, updated_at')
    .single();

  if (error || !data) {
    console.error('[promotions DELETE] archive error', error);
    return Response.json({ ok: false, error: error?.message ?? 'archive error' }, { status: 500 });
  }

  return Response.json({ ok: true, promotion: data });
}

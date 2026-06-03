import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/promotions
 * Lista TODAS las promociones (activas e inactivas) ordenadas por kind+nombre.
 * Es el endpoint que consume el admin para el CRUD. El storefront usa
 * /api/promotions/active (filtrado + hidratado con productos).
 */
export async function GET() {
  const { data, error } = await supabaseAdmin()
    .from('promotions')
    .select('id, kind, name, description, discount_type, discount_value, min_subtotal, config, active, starts_at, ends_at, created_at, updated_at')
    .order('kind')
    .order('name');

  if (error) {
    console.error('[promotions GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true, promotions: data ?? [] });
}

// `config` polimórfico según kind. Acepta los 3 campos opcionales (product_ids,
// weekdays, starts/ends_hhmm) y la validación cruzada se hace en `superRefine`
// para que el error sea legible (`"weekdays" requerido cuando kind='weekday'`).
const configSchema = z.object({
  product_ids: z.array(z.string().min(1)).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).optional(),
  starts_hhmm: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  ends_hhmm: z.string().regex(/^\d{2}:\d{2}$/).optional(),
}).default({});

const baseShape = {
  kind: z.enum(['product', 'weekday']),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  discount_type: z.enum(['percent', 'fixed', 'free_item', 'two_for_one']),
  discount_value: z.number().int().nonnegative(),
  min_subtotal: z.number().int().nonnegative().default(0),
  config: configSchema,
  active: z.boolean().default(true),
  starts_at: z.string().datetime().nullish(),
  ends_at: z.string().datetime().nullish(),
};

const createSchema = z.object(baseShape).superRefine((val, ctx) => {
  if (val.kind === 'product' && !(val.config.product_ids?.length)) {
    ctx.addIssue({ code: 'custom', path: ['config', 'product_ids'], message: "Requerido para kind='product'" });
  }
  if (val.kind === 'weekday' && !(val.config.weekdays?.length)) {
    ctx.addIssue({ code: 'custom', path: ['config', 'weekdays'], message: "Requerido para kind='weekday'" });
  }
  if (val.discount_type === 'percent' && (val.discount_value < 1 || val.discount_value > 100)) {
    ctx.addIssue({ code: 'custom', path: ['discount_value'], message: 'percent debe estar entre 1 y 100' });
  }
});

/**
 * POST /api/promotions
 * Crea una promoción. Valida que la combinación kind+config sea coherente
 * (un kind='weekday' sin weekdays no tiene sentido).
 */
export async function POST(request: NextRequest) {
  let parsed;
  try {
    parsed = createSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin()
    .from('promotions')
    .insert({
      kind: parsed.kind,
      name: parsed.name,
      description: parsed.description?.trim() ? parsed.description : null,
      discount_type: parsed.discount_type,
      discount_value: parsed.discount_value,
      min_subtotal: parsed.min_subtotal,
      config: parsed.config,
      active: parsed.active,
      starts_at: parsed.starts_at ?? null,
      ends_at: parsed.ends_at ?? null,
    })
    .select('id, kind, name, description, discount_type, discount_value, min_subtotal, config, active, starts_at, ends_at, created_at, updated_at')
    .single();

  if (error || !data) {
    console.error('[promotions POST] insert error', error);
    return Response.json({ ok: false, error: error?.message ?? 'insert error' }, { status: 500 });
  }

  return Response.json({ ok: true, promotion: data }, { status: 201 });
}

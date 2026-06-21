import { z } from 'zod';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/<companyId>/products
 * Devuelve el catálogo activo de LA empresa (incluye no-disponibles para que el
 * operario pueda toggle availability, pero excluye archivados — esos no aparecen
 * en ningún lado de la UI). Para el bot/tienda usar /api/products/available.
 *
 * Aislamiento: `ctx.db` (RLS = capa 2) + `.eq('company_id', ctx.company.id)` (capa 1).
 */
export const GET = withTenant(async (_request, ctx) => {
  const { data, error } = await ctx.db
    .from('products')
    .select('id, name, price, cat, sold, available, img, description')
    .eq('company_id', ctx.company.id)
    .eq('archived', false)
    .order('cat')
    .order('name');

  if (error) {
    console.error('[products GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true, products: data ?? [] });
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  // nonnegative (no positive): permite productos a $0, p. ej. el postre de la
  // categoría "Regalo" que se entrega gratis por dejar reseña.
  price: z.number().int().nonnegative(),
  cat: z.string().min(1).max(60),
  available: z.boolean().optional().default(true),
  /** URL externa o de Storage. Si el cliente recién creó el producto y va a
   *  subir imagen vía POST /:id/image, este campo puede venir vacío. */
  img: z.string().max(1000).optional().default(''),
  /** Descripción opcional. Se muestra en el card del admin y del cliente. */
  description: z.string().max(500).nullish(),
});

/**
 * POST /api/<companyId>/products
 * Crea un producto nuevo para LA empresa desde el panel "Nuevo producto".
 * El `id` se genera con `gen_prefixed_id('p')` (default de la columna).
 * Si el operario subió una imagen, el frontend hace POST /:id/image después.
 */
export const POST = withTenant(async (request, ctx) => {
  let parsed;
  try {
    parsed = createSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { data, error } = await ctx.db
    .from('products')
    .insert({
      company_id: ctx.company.id,
      name: parsed.name,
      price: parsed.price,
      cat: parsed.cat,
      available: parsed.available,
      img: parsed.img,
      // Normalizamos string vacío a null para que la columna refleje
      // "sin descripción" en lugar de un string vacío visualmente engañoso.
      description: parsed.description?.trim() ? parsed.description : null,
      sold: 0,
    })
    .select('id, name, price, cat, sold, available, img, description')
    .single();

  if (error || !data) {
    console.error('[products POST] insert error', error);
    return Response.json({ ok: false, error: error?.message ?? 'insert error' }, { status: 500 });
  }

  return Response.json({ ok: true, product: data }, { status: 201 });
});

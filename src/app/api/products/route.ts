import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/products
 * Devuelve TODO el catálogo (incluyendo no-disponibles). Lo consume la
 * pantalla Catálogo del panel, donde el operario puede toggle availability.
 * Para el bot, usar /api/products/available que solo trae available=true.
 */
export async function GET() {
  const { data, error } = await supabaseAdmin()
    .from('products')
    .select('id, name, price, cat, sold, available, img, description')
    .order('cat')
    .order('name');

  if (error) {
    console.error('[products GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true, products: data ?? [] });
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  price: z.number().int().positive(),
  cat: z.string().min(1).max(60),
  available: z.boolean().optional().default(true),
  /** URL externa o de Storage. Si el cliente recién creó el producto y va a
   *  subir imagen vía POST /:id/image, este campo puede venir vacío. */
  img: z.string().max(1000).optional().default(''),
  /** Descripción opcional. Se muestra en el card del admin y del cliente. */
  description: z.string().max(500).nullish(),
});

/**
 * POST /api/products
 * Crea un producto nuevo desde el panel "Nuevo producto" del Catálogo.
 * El `id` se genera con `gen_prefixed_id('p')` (default de la columna).
 * Si el operario subió una imagen, el frontend hace POST /:id/image después.
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
    .from('products')
    .insert({
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
}

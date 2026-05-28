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
    .select('id, name, price, cat, sold, available, img')
    .order('cat')
    .order('name');

  if (error) {
    console.error('[products GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true, products: data ?? [] });
}

import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Devuelve productos disponibles agrupados por categoría.
 * Lo consume el bot Kapso para mostrar la carta al cliente.
 */
export async function GET() {
  const { data, error } = await supabaseAdmin()
    .from('products')
    .select('id, name, price, cat')
    .eq('available', true)
    .order('cat')
    .order('name');

  if (error) {
    console.error('[products/available] db error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Agrupar por categoría para que el bot pueda mostrar secciones
  const byCategory = new Map<string, Array<{ id: string; name: string; price: number }>>();
  for (const p of data ?? []) {
    const list = byCategory.get(p.cat) ?? [];
    list.push({ id: p.id, name: p.name, price: p.price });
    byCategory.set(p.cat, list);
  }

  const categories = Array.from(byCategory.entries()).map(([name, items]) => ({
    name,
    items,
  }));

  return Response.json({ ok: true, categories });
}

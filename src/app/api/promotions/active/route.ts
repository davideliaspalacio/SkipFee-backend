import { supabaseAdmin } from '@/lib/db';
import { jsonWithCors, preflight } from '@/lib/checkout/cors';
import { isPromotionLiveNow, type PromotionRow } from '@/lib/checkout/promotions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/promotions/active
 *
 * Público — lo consume el storefront del cliente para pintar los
 * `<PromoActiveCard>` interactivos arriba del catálogo. Devuelve solo las
 * promos `active=true` cuya ventana de calendario (`starts_at`/`ends_at`)
 * incluye AHORA. NO filtra por weekday/hora — eso lo decide el frontend al
 * mostrar el banner del día (necesita la lista completa para mostrar las
 * promos disponibles "esta semana").
 *
 * Hidrata los productos elegibles (id, name, price, img, description) para
 * que el card del cliente los renderice sin un round-trip extra.
 */
export async function GET() {
  const sb = supabaseAdmin();

  const nowIso = new Date().toISOString();

  // Promos activas dentro de la ventana de calendario.
  // (filtros: active=true AND (starts_at IS NULL OR starts_at <= now)
  //                    AND (ends_at   IS NULL OR ends_at   >= now))
  const { data: promos, error } = await sb
    .from('promotions')
    .select('id, kind, name, description, discount_type, discount_value, min_subtotal, config, active, starts_at, ends_at')
    .eq('active', true)
    .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
    .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
    .order('kind')
    .order('name');

  if (error) {
    console.error('[promotions/active GET] error', error);
    return jsonWithCors({ ok: false, error: error.message }, 500);
  }

  // Filtramos por día/hora EN EL BACKEND: solo devolvemos lo que aplica
  // AHORA (en hora Bogotá) para que el storefront no tenga que reimplementar
  // la lógica. Las del rango de calendario que NO sean del día (o estén
  // fuera de su ventana horaria) quedan ocultas al cliente.
  const now = new Date();
  const rows = ((promos ?? []) as PromotionRow[]).filter(p => isPromotionLiveNow(p, now));

  // Cosecha ids únicos para hidratar productos en una sola query.
  const productIds = new Set<string>();
  for (const p of rows) {
    for (const id of p.config.product_ids ?? []) productIds.add(id);
  }

  let productsById = new Map<string, ProductLite>();
  if (productIds.size > 0) {
    const { data: products } = await sb
      .from('products')
      .select('id, name, price, cat, img, description, available')
      .eq('archived', false)
      .in('id', Array.from(productIds));
    productsById = new Map(
      (products ?? []).map(p => [
        p.id as string,
        {
          id: p.id as string,
          name: p.name as string,
          price: p.price as number,
          cat: p.cat as string,
          img: (p.img as string | null) && (p.img as string).trim() ? (p.img as string) : null,
          description: (p.description as string | null) && (p.description as string).trim()
            ? (p.description as string)
            : null,
          available: p.available as boolean,
        },
      ]),
    );
  }

  // Cada promo embebe sus productos elegibles ya hidratados (solo los
  // available — productos agotados no se muestran en el card).
  const promotions = rows.map(p => ({
    id: p.id,
    kind: p.kind,
    name: p.name,
    description: p.description,
    discount_type: p.discount_type,
    discount_value: p.discount_value,
    min_subtotal: p.min_subtotal,
    config: p.config,
    starts_at: p.starts_at,
    ends_at: p.ends_at,
    products: (p.config.product_ids ?? [])
      .map(id => productsById.get(id))
      .filter((x): x is ProductLite => !!x && x.available),
  }));

  return jsonWithCors({ ok: true, promotions });
}

export async function OPTIONS() {
  return preflight();
}

interface ProductLite {
  id: string;
  name: string;
  price: number;
  cat: string;
  img: string | null;
  description: string | null;
  available: boolean;
}

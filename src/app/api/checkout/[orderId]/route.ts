import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { jsonWithCors, preflight } from '@/lib/checkout/cors';
import { buildCatalog, classifyOrder, emptyCart } from '@/lib/checkout/shape';
import { giftCartLine } from '@/lib/checkout/gift';
import { computeOrderTotals, type TotalsProduct, type TotalsZone } from '@/lib/checkout/totals';
import { loadOpenState } from '@/lib/hours';
import type { PromotionRow } from '@/lib/checkout/promotions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/checkout/:orderId?userId=<phone>   (público — la tienda al cargar)
 *
 * Siempre responde 200 con un `status` discriminado (CONTRACT_CHECKOUT.md §2):
 *  - valida        ⇒ devuelve order (cart actual + delivery/customer prefill),
 *                    catalog embebido y zones.
 *  - ya_usada      ⇒ devuelve { ok, status, order: { orderStatus, orderNumber } }
 *                    para que la pantalla post-pago muestre el progress real
 *                    (pagado → cocina → ruta → entregado).
 *  - expirada / no_encontrada ⇒ solo { ok, status }.
 *
 * El `cart` se recalcula con `computeOrderTotals` sobre los items guardados y el
 * catálogo/zona/settings actuales, para que GET y PUT siempre coincidan.
 */

type OrderItemRow = {
  qty: number;
  price_at_order: number;
  product: { id: string; name: string } | { id: string; name: string }[] | null;
};

type OrderRow = {
  id: string;
  phone: string;
  status: string;
  expires_at: string | null;
  address: string | null;
  zone_id: string | null;
  lat: number | null;
  lng: number | null;
  note: string | null;
  wompi_status_message: string | null;
  order_number: number | null;
  tip: number | null;
  tip_percent: number | null;
  customer: { name: string; email: string | null } | { name: string; email: string | null }[] | null;
  items: OrderItemRow[] | null;
};

function pickOne<T>(value: T | T[] | null): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function GET(_request: NextRequest, ctx: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await ctx.params;
  const sb = supabaseAdmin();

  const { data: order } = (await sb
    .from('orders')
    .select(
      `id, phone, status, expires_at, address, zone_id, lat, lng, note, wompi_status_message, order_number, tip, tip_percent,
       customer:customers(name, email),
       items:order_items(qty, price_at_order, product:products(id, name))`,
    )
    .eq('id', orderId)
    .single()) as { data: OrderRow | null };

  const status = classifyOrder(order, new Date());
  if (status !== 'valida' || !order) {
    // `ya_usada` cubre orden ya en pipeline (pagado/cocina/ruta/entregado/etc).
    // Devolvemos el status real y el order_number para que la pantalla
    // post-pago pueda mostrar el progress y un identificador legible.
    if (status === 'ya_usada' && order) {
      return jsonWithCors({
        ok: true,
        status,
        order: {
          orderId: order.id,
          orderStatus: order.status,
          orderNumber: order.order_number ?? null,
        },
      });
    }
    return jsonWithCors({ ok: true, status });
  }

  // Catálogo + zonas + settings + promos activas + estado de operación (todo en paralelo).
  // Las promos las recalculamos en cada GET para que el cart refleje la promo
  // vigente AHORA; `openState` decide si la tienda muestra "cerrado".
  const nowIso = new Date().toISOString();
  const [{ data: products }, { data: zones }, { data: settings }, { data: promotions }, openState] = await Promise.all([
    sb.from('products').select('id, name, price, cat, available, img, description').eq('available', true).eq('archived', false).order('cat').order('name'),
    sb.from('zones').select('id, name, tarifa, recargo, color, lat, lng').order('name'),
    sb.from('settings').select('peak_start, peak_end, base_delivery_fee').eq('id', 1).single(),
    sb.from('promotions')
      .select('id, kind, name, description, discount_type, discount_value, min_subtotal, config, active, starts_at, ends_at')
      .eq('active', true)
      .eq('archived', false),
    loadOpenState(sb),
  ]);

  // `img` y `description` los agregamos al SELECT para embeberlos en el
  // catálogo — `TotalsProduct` viene de pricing y solo conoce los campos
  // que tocan el cálculo, los extendemos aquí.
  const productList = (products ?? []) as Array<
    TotalsProduct & { cat: string; img: string | null; description: string | null }
  >;
  const zoneList = (zones ?? []) as Array<TotalsZone & { color?: string }>;
  const zone = order.zone_id ? zoneList.find(z => z.id === order.zone_id) ?? null : null;

  // Reconstruir el carrito guardado (items: productId + qty desde order_items).
  const savedItems = (order.items ?? []).map(it => {
    const p = pickOne(it.product);
    return { productId: p?.id ?? '', qty: it.qty };
  }).filter(i => i.productId);

  let cart: ReturnType<typeof emptyCart>;
  if (savedItems.length > 0 && settings) {
    const totals = computeOrderTotals({
      items: savedItems,
      products: productList,
      zone,
      settings,
      now: new Date(),
      promotions: (promotions ?? []) as PromotionRow[],
    });
    cart = {
      items: totals.items,
      subtotal: totals.subtotal,
      discount: totals.discount,
      delivery: totals.delivery,
      peakSurcharge: totals.peakSurcharge,
      tip: order.tip ?? 0,
      tipPercent: order.tip_percent ?? null,
      total: totals.total + (order.tip ?? 0),
      appliedPromo: totals.appliedPromo,
    };
  } else {
    cart = emptyCart();
  }

  // Postre de regalo (Tarea 3): línea calculada a $0 si el cliente tiene un cupón
  // 'otorgado' vigente y hay producto de regalo configurado. NO se persiste en
  // order_items mientras es borrador (el order_item real lo inserta el canje al
  // pagar); acá solo se muestra en el carrito de la tienda.
  const giftLine = await giftCartLine(sb, order.phone, nowIso);
  if (giftLine) cart.items.push(giftLine);
  const gift = giftLine ? { name: giftLine.name } : null;

  // Prefill de delivery: solo si hay algo guardado (dirección o zona).
  const delivery =
    order.address || order.zone_id
      ? { address: order.address ?? null, zoneId: order.zone_id ?? null, lat: order.lat ?? null, lng: order.lng ?? null }
      : null;

  const customer = pickOne(order.customer);

  return jsonWithCors({
    ok: true,
    status: 'valida',
    order: {
      orderId: order.id,
      phone: order.phone,
      expiresAt: order.expires_at,
      cart,
      delivery,
      customer: customer ? { name: customer.name, email: customer.email ?? null } : null,
      // Si el cliente intentó pagar y le rechazaron (webhook DECLINED/ERROR
      // volvió la orden a `borrador`), el frontend usa esto para mostrarle
      // el motivo y ofrecerle reintentar con otra tarjeta/método.
      wompiStatusMessage: order.wompi_status_message ?? null,
      // Postre de regalo disponible (cupón vigente) → la tienda muestra el aviso.
      gift,
    },
    catalog: buildCatalog(
      productList.map(p => ({
        id: p.id,
        name: p.name,
        price: p.price,
        cat: p.cat,
        // products.img es NOT NULL pero puede venir como '' si nadie subió
        // foto. Lo normalizamos a null para que el storefront caiga al
        // placeholder de categoría sin renderizar un <img src=""> roto.
        img: p.img && p.img.trim() ? p.img : null,
        description: p.description && p.description.trim() ? p.description : null,
      })),
    ),
    zones: zoneList.map(z => ({ id: z.id, name: z.name ?? '', tarifa: z.tarifa, recargo: z.recargo })),
    // Estado de operación: la tienda muestra "cerrado" y bloquea el pago si está cerrado.
    businessOpen: openState.open,
    opensLabel: openState.opensLabel,
  });
}

export async function OPTIONS() {
  return preflight();
}

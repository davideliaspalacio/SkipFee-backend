import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { jsonWithCors, preflight } from '@/lib/checkout/cors';
import { buildCatalog, classifyOrder, emptyCart } from '@/lib/checkout/shape';
import { computeOrderTotals, type TotalsProduct, type TotalsZone } from '@/lib/checkout/totals';

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
      `id, phone, status, expires_at, address, zone_id, lat, lng, note, wompi_status_message, order_number,
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

  // Catálogo + zonas + settings (para recalcular el carrito y embeber catálogo).
  const [{ data: products }, { data: zones }, { data: settings }] = await Promise.all([
    sb.from('products').select('id, name, price, cat, available, img, description').eq('available', true).order('cat').order('name'),
    sb.from('zones').select('id, name, tarifa, recargo, color, lat, lng').order('name'),
    sb.from('settings').select('peak_start, peak_end, base_delivery_fee').eq('id', 1).single(),
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
    });
    cart = {
      items: totals.items,
      subtotal: totals.subtotal,
      delivery: totals.delivery,
      peakSurcharge: totals.peakSurcharge,
      total: totals.total,
    };
  } else {
    cart = emptyCart();
  }

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
  });
}

export async function OPTIONS() {
  return preflight();
}

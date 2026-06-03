import { resolveAutomaticPromotion, toAppliedPromotion, type AppliedPromotion, type PromotionRow } from './promotions';

/**
 * Lógica de precio compartida entre /api/orders y el checkout web.
 *
 * Es una función **pura** (sin I/O): recibe los items pedidos, el catálogo ya
 * resuelto, la zona y los settings, y devuelve subtotal/delivery/peakSurcharge/
 * total más las líneas listas para mostrar (forma del contrato) y para persistir
 * en `order_items`.
 *
 * Reglas:
 *  - subtotal = Σ price * qty (precio actual del producto).
 *  - delivery = zone.tarifa (sin zona ⇒ 0). La "hora pico" fue ELIMINADA del
 *    producto: `peakSurcharge` siempre es 0 (se conserva por compat del contrato).
 *  - carrito vacío ⇒ delivery 0 y total 0 (aún no hay nada que enviar).
 *  - productos no disponibles ⇒ unavailable[] (por nombre); inexistentes ⇒
 *    missing[] (por id). El caller decide cómo responder (409 / 400).
 */

export interface TotalsProduct {
  id: string;
  name: string;
  price: number;
  available: boolean;
}

export interface TotalsZone {
  id: string;
  name?: string;
  tarifa: number;
  /** @deprecated hora pico eliminada; ya no se usa para el domicilio. */
  recargo?: number;
  lat?: number;
  lng?: number;
}

export interface TotalsSettings {
  peak_start: string | null;
  peak_end: string | null;
  base_delivery_fee: number;
}

export interface TotalsItemInput {
  productId: string;
  qty: number;
}

export interface CartLine {
  productId: string;
  name: string;
  qty: number;
  price: number;
  lineTotal: number;
}

export interface OrderItemInsert {
  product_id: string;
  qty: number;
  price_at_order: number;
}

export interface OrderTotals {
  items: CartLine[];
  itemsToInsert: OrderItemInsert[];
  subtotal: number;
  /** Descuento total aplicado por la promo automática elegida (siempre ≥0). */
  discount: number;
  delivery: number;
  peakSurcharge: number;
  total: number;
  /** Promo aplicada (la mejor entre las pasadas), o `null` si ninguna aplicó. */
  appliedPromo: AppliedPromotion | null;
  /** Nombres de productos existentes pero no disponibles. */
  unavailable: string[];
  /** IDs de productos que no existen en el catálogo. */
  missing: string[];
}

export function computeOrderTotals(input: {
  items: TotalsItemInput[];
  products: TotalsProduct[];
  zone: TotalsZone | null;
  settings: TotalsSettings;
  now?: Date;
  /** Promos automáticas candidatas. Si no se pasan, no hay descuento.
   *  La función elige internamente la que más descuento dé al cliente. */
  promotions?: PromotionRow[];
}): OrderTotals {
  const { items, products, zone } = input;
  const now = input.now ?? new Date();
  const promotions = input.promotions ?? [];

  const productById = new Map(products.map(p => [p.id, p]));

  const lines: CartLine[] = [];
  const itemsToInsert: OrderItemInsert[] = [];
  const unavailable: string[] = [];
  const missing: string[] = [];
  let subtotal = 0;

  for (const it of items) {
    const p = productById.get(it.productId);
    if (!p) {
      missing.push(it.productId);
      continue;
    }
    if (!p.available) {
      unavailable.push(p.name);
      continue;
    }
    const lineTotal = p.price * it.qty;
    subtotal += lineTotal;
    lines.push({ productId: p.id, name: p.name, qty: it.qty, price: p.price, lineTotal });
    itemsToInsert.push({ product_id: p.id, qty: it.qty, price_at_order: p.price });
  }

  // Carrito vacío (o todo inválido): nada que enviar ⇒ delivery/total 0.
  const hasItems = lines.length > 0;

  // El precio del domicilio SIEMPRE sale de la zona seleccionada (la que el bot
  // capturó). Sin zona ⇒ delivery = 0 y el storefront NO muestra la línea hasta
  // que se complete la entrega. La hora pico fue eliminada: ya no hay recargo.
  let delivery = 0;
  if (hasItems && zone) {
    delivery = zone.tarifa;
  }
  // `peakSurcharge` se conserva en 0 por compatibilidad del contrato del carrito
  // (el frontend auto-oculta la línea cuando es 0).
  const peakSurcharge = 0;

  // Resolvemos la mejor promo automática y la descontamos SOLO del subtotal
  // (nunca del delivery — regla de negocio). El cálculo es:
  //   total = max(0, subtotal - discount) + delivery
  // El `max` blinda contra promos mal configuradas que descontarían más que
  // el subtotal (e.g. un `fixed` muy alto vs subtotal pequeño).
  const promoResult = hasItems
    ? resolveAutomaticPromotion({ items, products, subtotal, now, promotions })
    : null;
  const discount = promoResult?.discount ?? 0;
  const appliedPromo = promoResult ? toAppliedPromotion(promoResult.promotion, discount) : null;

  const total = Math.max(0, subtotal - discount) + delivery;

  return {
    items: lines,
    itemsToInsert,
    subtotal,
    discount,
    delivery,
    peakSurcharge,
    total,
    appliedPromo,
    unavailable,
    missing,
  };
}

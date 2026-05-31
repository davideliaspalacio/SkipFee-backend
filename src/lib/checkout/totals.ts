import { bogotaTime, isWithinRange } from '@/lib/pricing';

/**
 * Lógica de precio compartida entre /api/orders y el checkout web.
 *
 * Es una función **pura** (sin I/O): recibe los items pedidos, el catálogo ya
 * resuelto, la zona y los settings, y devuelve subtotal/delivery/peakSurcharge/
 * total más las líneas listas para mostrar (forma del contrato) y para persistir
 * en `order_items`.
 *
 * Reglas (espejo de la lógica original de /api/orders):
 *  - subtotal = Σ price * qty (precio actual del producto).
 *  - delivery = zone.tarifa + (hora pico ? zone.recargo : 0). Sin zona, se usa
 *    settings.base_delivery_fee y no hay recargo (no tenemos dato de la zona).
 *  - hora pico: now (en America/Bogota, HH:MM) dentro de [peak_start, peak_end].
 *  - peakSurcharge se reporta aparte (lo que el cliente ve como recargo).
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
  recargo: number;
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
  delivery: number;
  peakSurcharge: number;
  total: number;
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
}): OrderTotals {
  const { items, products, zone, settings } = input;
  const now = input.now ?? new Date();

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
  const isPeak = isWithinRange(bogotaTime(now), settings.peak_start, settings.peak_end);

  let delivery = 0;
  let peakSurcharge = 0;
  if (hasItems) {
    if (zone) {
      peakSurcharge = isPeak ? zone.recargo : 0;
      delivery = zone.tarifa + peakSurcharge;
    } else {
      // Sin zona conocida: tarifa base, sin recargo de hora pico.
      delivery = settings.base_delivery_fee;
      peakSurcharge = 0;
    }
  }

  const total = subtotal + delivery;

  return { items: lines, itemsToInsert, subtotal, delivery, peakSurcharge, total, unavailable, missing };
}

/**
 * Helpers de forma (puros) para las respuestas del checkout web.
 * Mantienen el contrato CONTRACT_CHECKOUT.md §2/§3 con el frontend.
 */

export interface CatalogProduct {
  id: string;
  name: string;
  price: number;
  cat: string;
  /** URL pública de la imagen (Storage o externa). `null` si no hay foto cargada. */
  img: string | null;
  /** Descripción corta para mostrar al cliente debajo del nombre. `null` si vacía. */
  description: string | null;
}

export interface Catalog {
  categories: Array<{
    cat: string;
    items: Array<{
      id: string;
      name: string;
      price: number;
      cat: string;
      img: string | null;
      description: string | null;
    }>;
  }>;
}

/**
 * Catálogo embebido del GET: agrupa por categoría preservando el orden de
 * aparición. Cada item es la forma reducida `{ id, name, price, cat, img,
 * description }` — incluye `img` y `description` para que el storefront
 * muestre la foto y el texto del producto en lugar del placeholder.
 */
export function buildCatalog(products: CatalogProduct[]): Catalog {
  const byCat = new Map<string, Catalog['categories'][number]['items']>();
  for (const p of products) {
    const list = byCat.get(p.cat) ?? [];
    list.push({
      id: p.id,
      name: p.name,
      price: p.price,
      cat: p.cat,
      img: p.img,
      description: p.description,
    });
    byCat.set(p.cat, list);
  }
  return {
    categories: Array.from(byCat.entries()).map(([cat, items]) => ({ cat, items })),
  };
}

export interface Cart {
  items: Array<{ productId: string; name: string; qty: number; price: number; lineTotal: number; gift?: boolean }>;
  subtotal: number;
  /** Descuento total aplicado por la promo automática (siempre ≥0). 0 si no hay. */
  discount: number;
  delivery: number;
  peakSurcharge: number;
  /** Propina elegida por el cliente (COP). 0 si no puso. Ya incluida en `total`. */
  tip: number;
  /** % de propina elegido (p. ej. 10) para recordar el modo del selector; null si custom/none. */
  tipPercent: number | null;
  total: number;
  /** Promo aplicada al carrito en este recálculo. `null` si ninguna aplica. */
  appliedPromo: CartAppliedPromo | null;
}

export interface CartAppliedPromo {
  id: string;
  name: string;
  description: string | null;
  kind: 'product' | 'weekday';
  discountType: 'percent' | 'fixed' | 'free_item' | 'two_for_one';
  amount: number;
}

/** Carrito vacío (cliente aún no agregó nada). */
export function emptyCart(): Cart {
  return { items: [], subtotal: 0, discount: 0, delivery: 0, peakSurcharge: 0, tip: 0, tipPercent: null, total: 0, appliedPromo: null };
}

export type CheckoutStatus = 'valida' | 'expirada' | 'no_encontrada' | 'ya_usada';

/**
 * Clasifica el estado de una orden para la respuesta discriminada del GET:
 *  - no existe                       ⇒ no_encontrada
 *  - status='expirado'               ⇒ expirada
 *  - status='borrador' + vencida     ⇒ expirada
 *  - status='borrador' + no vencida  ⇒ valida
 *  - cualquier otro estado (nuevo/pagado/...) ⇒ ya_usada
 *
 * "Vencida" = expires_at < now (un borrador sin expires_at no caduca por dato
 * faltante; igual el cron solo toca los que tienen expires_at).
 */
export function classifyOrder(
  order: { status: string; expires_at: string | null } | null,
  now: Date = new Date(),
): CheckoutStatus {
  if (!order) return 'no_encontrada';
  if (order.status === 'expirado') return 'expirada';
  if (order.status === 'borrador') {
    if (order.expires_at && new Date(order.expires_at).getTime() < now.getTime()) {
      return 'expirada';
    }
    return 'valida';
  }
  return 'ya_usada';
}

/**
 * Sistema de promociones automáticas — lógica pura.
 *
 * No toca Supabase: recibe las promos ya cargadas y decide cuál aplica al
 * carrito en este momento. La integración con la BD vive en los route
 * handlers (cart route resuelve + persiste; /promotions/active expone).
 *
 * Decisión de diseño: cuando varias promos pueden aplicar a la vez, gana la
 * que produzca el descuento más alto. Esto evita tener que pensar reglas
 * de prioridad por tipo y mantiene predecible la UX ("siempre te damos el
 * mejor precio").
 */

import { bogotaTime, isWithinRange } from '@/lib/pricing';
import type { TotalsItemInput, TotalsProduct } from './totals';

export type PromotionKind = 'product' | 'weekday';
export type DiscountType = 'percent' | 'fixed' | 'free_item' | 'two_for_one';

/** Forma cruda como viene de la tabla `promotions`. */
export interface PromotionRow {
  id: string;
  kind: PromotionKind;
  name: string;
  description: string | null;
  discount_type: DiscountType;
  discount_value: number;
  min_subtotal: number;
  config: PromotionConfig;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

/** Config polimórfica según `kind`. */
export interface PromotionConfig {
  /** kind='product' o 'weekday' con productos: ids elegibles. */
  product_ids?: string[];
  /** kind='weekday': días de la semana (0=domingo, 6=sábado, JS getDay()). */
  weekdays?: number[];
  /** kind='weekday': ventana horaria opcional "HH:MM". */
  starts_hhmm?: string;
  ends_hhmm?: string;
}

/** Snapshot del descuento aplicado a un carrito. */
export interface AppliedPromotion {
  id: string;
  name: string;
  description: string | null;
  kind: PromotionKind;
  discountType: DiscountType;
  /** Monto descontado en COP (siempre positivo, redondeado al entero). */
  amount: number;
}

interface EvaluateContext {
  items: TotalsItemInput[];
  products: TotalsProduct[];
  /** Subtotal del carrito ANTES del descuento (productos disponibles). */
  subtotal: number;
  now: Date;
}

/**
 * Calcula cuánto descontaría esta promo en este carrito y este momento.
 * Devuelve 0 si la promo no aplica (no vigente, no llega al mínimo, no hay
 * productos elegibles, no es el día/hora, etc.).
 */
export function evaluatePromotion(promo: PromotionRow, ctx: EvaluateContext): number {
  if (!promo.active) return 0;
  if (!isInCalendarWindow(promo, ctx.now)) return 0;
  if (promo.kind === 'weekday' && !isInWeekdayWindow(promo, ctx.now)) return 0;
  if (ctx.subtotal < promo.min_subtotal) return 0;

  // Productos elegibles según la config (puede ser todo o un subset).
  const eligibleIds = new Set(promo.config.product_ids ?? []);
  const restrictsByProduct = eligibleIds.size > 0;
  const productById = new Map(ctx.products.map(p => [p.id, p]));

  // Líneas elegibles, ya filtradas por available y existencia.
  const eligibleLines = ctx.items
    .map(it => ({ item: it, product: productById.get(it.productId) }))
    .filter(x => x.product && x.product.available)
    .filter(x => (restrictsByProduct ? eligibleIds.has(x.product!.id) : true)) as Array<{
    item: TotalsItemInput;
    product: TotalsProduct;
  }>;

  if (eligibleLines.length === 0) return 0;

  const eligibleSubtotal = eligibleLines.reduce(
    (acc, { item, product }) => acc + product.price * item.qty,
    0,
  );

  switch (promo.discount_type) {
    case 'percent': {
      const pct = clamp(promo.discount_value, 0, 100);
      return Math.floor((eligibleSubtotal * pct) / 100);
    }
    case 'fixed': {
      // No descontar más que lo elegible (evita totales negativos).
      return Math.min(promo.discount_value, eligibleSubtotal);
    }
    case 'free_item': {
      // Descuenta el precio unitario del producto elegible MÁS BARATO presente
      // en el carrito (1 unidad). UX común: "agregá X y te regalamos uno".
      const minPrice = eligibleLines.reduce(
        (acc, { product }) => Math.min(acc, product.price),
        Number.POSITIVE_INFINITY,
      );
      return Number.isFinite(minPrice) ? minPrice : 0;
    }
    case 'two_for_one': {
      // Por cada par de unidades elegibles, descuenta el precio unitario más
      // bajo entre las elegibles. Es la interpretación más generosa para el
      // cliente: si compra 2 Pastrami ($29.000) y 1 Cubano ($27.000), elegibles
      // los 3, descuenta $27.000 (1 par) — gratis el más barato.
      // Si tiene 4 elegibles, descuenta 2 unidades más baratas.
      const totalEligibleUnits = eligibleLines.reduce((acc, { item }) => acc + item.qty, 0);
      const pairs = Math.floor(totalEligibleUnits / 2);
      if (pairs === 0) return 0;
      // Unidades expandidas ordenadas asc por precio: las "gratis" son las más baratas.
      const unitPrices: number[] = [];
      for (const { item, product } of eligibleLines) {
        for (let i = 0; i < item.qty; i++) unitPrices.push(product.price);
      }
      unitPrices.sort((a, b) => a - b);
      return unitPrices.slice(0, pairs).reduce((acc, p) => acc + p, 0);
    }
    default:
      return 0;
  }
}

/**
 * Elige la mejor promo automática para este carrito (o `null` si ninguna
 * aplica). "Mejor" = mayor monto de descuento.
 */
export function resolveAutomaticPromotion(input: {
  items: TotalsItemInput[];
  products: TotalsProduct[];
  subtotal: number;
  now: Date;
  promotions: PromotionRow[];
}): { promotion: PromotionRow; discount: number } | null {
  const { items, products, subtotal, now, promotions } = input;
  let best: { promotion: PromotionRow; discount: number } | null = null;
  for (const promo of promotions) {
    const discount = evaluatePromotion(promo, { items, products, subtotal, now });
    if (discount <= 0) continue;
    if (!best || discount > best.discount) {
      best = { promotion: promo, discount };
    }
  }
  return best;
}

/** Construye el shape `AppliedPromotion` listo para guardar en orders + GET cart. */
export function toAppliedPromotion(promo: PromotionRow, amount: number): AppliedPromotion {
  return {
    id: promo.id,
    name: promo.name,
    description: promo.description,
    kind: promo.kind,
    discountType: promo.discount_type,
    amount,
  };
}

/**
 * True si la promo está vigente AHORA (activa + dentro de calendario + para
 * weekday también dentro del día/ventana horaria). Lo usa el endpoint público
 * `/api/promotions/active` para devolver solo lo que el cliente puede usar
 * en este momento — así el frontend no tiene que filtrar.
 */
export function isPromotionLiveNow(promo: PromotionRow, now: Date): boolean {
  if (!promo.active) return false;
  if (!isInCalendarWindow(promo, now)) return false;
  if (promo.kind === 'weekday' && !isInWeekdayWindow(promo, now)) return false;
  return true;
}

// -------------------- helpers privados --------------------

function isInCalendarWindow(promo: PromotionRow, now: Date): boolean {
  const t = now.getTime();
  if (promo.starts_at && t < new Date(promo.starts_at).getTime()) return false;
  if (promo.ends_at && t > new Date(promo.ends_at).getTime()) return false;
  return true;
}

function isInWeekdayWindow(promo: PromotionRow, now: Date): boolean {
  const cfg = promo.config;
  const weekdays = cfg.weekdays ?? [];
  if (weekdays.length === 0) return true; // sin restricción de día
  // Día y hora en zona horaria de Bogotá (ahí vive el negocio).
  const bogotaWeekday = bogotaWeekdayOf(now);
  if (!weekdays.includes(bogotaWeekday)) return false;
  if (cfg.starts_hhmm || cfg.ends_hhmm) {
    return isWithinRange(bogotaTime(now), cfg.starts_hhmm ?? null, cfg.ends_hhmm ?? null);
  }
  return true;
}

/** Día de la semana en zona Bogotá (0=domingo, 6=sábado), espejo de `getDay()`. */
function bogotaWeekdayOf(now: Date): number {
  // `Intl` con America/Bogota nos da el weekday textual; lo mapeamos a número.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota',
    weekday: 'short',
  });
  const short = fmt.format(now); // "Sun","Mon",...
  const map: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return map[short] ?? now.getDay();
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

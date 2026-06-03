import { describe, it, expect } from 'vitest';
import { computeOrderTotals } from './totals';
import type { PromotionRow } from './promotions';

const PRODUCTS = [
  { id: 'p01', name: 'Pastrami Bros', price: 28000, available: true },
  { id: 'b03', name: 'Limonada', price: 4500, available: true },
  { id: 'x99', name: 'Agotado', price: 10000, available: false },
];

const ZONE = { id: 'poblado', name: 'El Poblado', tarifa: 4500, recargo: 1500, lat: 6.2, lng: -75.5 };
const SETTINGS = { peak_start: '12:00', peak_end: '14:00', base_delivery_fee: 4500 };

// 15:00 Bogota (UTC-5) => 20:00 UTC, fuera de hora pico
const OFFPEAK = new Date('2026-05-31T20:00:00.000Z');
// 13:00 Bogota => 18:00 UTC, dentro de hora pico
const PEAK = new Date('2026-05-31T18:00:00.000Z');

describe('computeOrderTotals', () => {
  it('calcula subtotal, lineTotal y total con zona fuera de hora pico', () => {
    const r = computeOrderTotals({
      items: [{ productId: 'p01', qty: 2 }, { productId: 'b03', qty: 1 }],
      products: PRODUCTS,
      zone: ZONE,
      settings: SETTINGS,
      now: OFFPEAK,
    });

    expect(r.unavailable).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.subtotal).toBe(28000 * 2 + 4500);
    expect(r.delivery).toBe(4500);
    expect(r.peakSurcharge).toBe(0);
    expect(r.total).toBe(28000 * 2 + 4500 + 4500);
    expect(r.items).toEqual([
      { productId: 'p01', name: 'Pastrami Bros', qty: 2, price: 28000, lineTotal: 56000 },
      { productId: 'b03', name: 'Limonada', qty: 1, price: 4500, lineTotal: 4500 },
    ]);
    // items para persistir en order_items
    expect(r.itemsToInsert).toEqual([
      { product_id: 'p01', qty: 2, price_at_order: 28000 },
      { product_id: 'b03', qty: 1, price_at_order: 4500 },
    ]);
  });

  it('hora pico ELIMINADA: domicilio = zone.tarifa siempre, sin recargo', () => {
    const r = computeOrderTotals({
      items: [{ productId: 'p01', qty: 1 }],
      products: PRODUCTS,
      zone: ZONE,
      settings: SETTINGS,
      now: PEAK, // antes caía en hora pico; ahora no cambia nada
    });
    expect(r.peakSurcharge).toBe(0);
    expect(r.delivery).toBe(4500);
    expect(r.total).toBe(28000 + 4500);
  });

  it('reporta productos no disponibles en unavailable[] (por nombre)', () => {
    const r = computeOrderTotals({
      items: [{ productId: 'p01', qty: 1 }, { productId: 'x99', qty: 1 }],
      products: PRODUCTS,
      zone: ZONE,
      settings: SETTINGS,
      now: OFFPEAK,
    });
    expect(r.unavailable).toEqual(['Agotado']);
  });

  it('reporta productos inexistentes en missing[] (por id)', () => {
    const r = computeOrderTotals({
      items: [{ productId: 'nope', qty: 1 }],
      products: PRODUCTS,
      zone: ZONE,
      settings: SETTINGS,
      now: OFFPEAK,
    });
    expect(r.missing).toEqual(['nope']);
  });

  it('sin zona: delivery = 0 (no inventamos precio sin saber dónde entregar)', () => {
    // Caso: el cliente abre el carrito antes de que el bot haya capturado la
    // dirección. Mostrar `settings.base_delivery_fee` como fallback genera
    // un cambio visual cuando llega la zona real ($4.500 → $5.000) y confunde.
    const r = computeOrderTotals({
      items: [{ productId: 'p01', qty: 1 }],
      products: PRODUCTS,
      zone: null,
      settings: SETTINGS,
      now: PEAK,
    });
    expect(r.delivery).toBe(0);
    expect(r.peakSurcharge).toBe(0);
    expect(r.total).toBe(28000);
  });

  it('carrito vacío: totales en 0, delivery 0', () => {
    const r = computeOrderTotals({
      items: [],
      products: PRODUCTS,
      zone: ZONE,
      settings: SETTINGS,
      now: OFFPEAK,
    });
    expect(r.subtotal).toBe(0);
    expect(r.delivery).toBe(0);
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
    expect(r.discount).toBe(0);
    expect(r.appliedPromo).toBeNull();
  });
});

describe('computeOrderTotals — con promociones', () => {
  function promo(over: Partial<PromotionRow> = {}): PromotionRow {
    return {
      id: 'pr1', kind: 'product', name: 'P', description: null,
      discount_type: 'percent', discount_value: 20,
      min_subtotal: 0, config: {}, active: true,
      starts_at: null, ends_at: null,
      ...over,
    };
  }

  it('descuenta solo del subtotal, NO del delivery', () => {
    const r = computeOrderTotals({
      items: [{ productId: 'p01', qty: 1 }],
      products: PRODUCTS,
      zone: ZONE,
      settings: SETTINGS,
      now: OFFPEAK,
      promotions: [promo({ discount_value: 10 })], // 10% off
    });
    expect(r.subtotal).toBe(28000);
    expect(r.discount).toBe(2800);
    expect(r.delivery).toBe(4500); // sin tocar
    expect(r.total).toBe(28000 - 2800 + 4500);
    expect(r.appliedPromo?.id).toBe('pr1');
    expect(r.appliedPromo?.amount).toBe(2800);
  });

  it('elige la promo con mayor descuento entre varias activas', () => {
    const r = computeOrderTotals({
      items: [{ productId: 'p01', qty: 1 }],
      products: PRODUCTS,
      zone: ZONE,
      settings: SETTINGS,
      now: OFFPEAK,
      promotions: [
        promo({ id: 'p10', discount_value: 10 }),  // 2.800
        promo({ id: 'p20', discount_value: 20 }),  // 5.600  ← gana
      ],
    });
    expect(r.appliedPromo?.id).toBe('p20');
    expect(r.discount).toBe(5600);
  });

  it('carrito vacío: ignora promos (sin discount, sin appliedPromo)', () => {
    const r = computeOrderTotals({
      items: [],
      products: PRODUCTS,
      zone: ZONE,
      settings: SETTINGS,
      now: OFFPEAK,
      promotions: [promo({ discount_value: 50 })],
    });
    expect(r.discount).toBe(0);
    expect(r.appliedPromo).toBeNull();
  });

  it('promo no aplicable (sin elegibles en carrito) ⇒ discount 0', () => {
    const r = computeOrderTotals({
      items: [{ productId: 'p01', qty: 1 }],
      products: PRODUCTS,
      zone: ZONE,
      settings: SETTINGS,
      now: OFFPEAK,
      promotions: [promo({ config: { product_ids: ['b03'] } })], // solo limonada
    });
    expect(r.discount).toBe(0);
    expect(r.appliedPromo).toBeNull();
    expect(r.total).toBe(28000 + 4500);
  });

  it('descuento nunca lleva el subtotal a negativo (Math.max)', () => {
    const r = computeOrderTotals({
      items: [{ productId: 'b03', qty: 1 }], // 4.500
      products: PRODUCTS,
      zone: ZONE,
      settings: SETTINGS,
      now: OFFPEAK,
      promotions: [promo({ discount_type: 'fixed', discount_value: 100000 })],
    });
    expect(r.subtotal).toBe(4500);
    expect(r.discount).toBe(4500); // cap por el helper de fixed
    expect(r.total).toBe(0 + 4500); // 0 productos + delivery
  });
});

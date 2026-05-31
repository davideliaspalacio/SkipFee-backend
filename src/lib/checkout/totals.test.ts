import { describe, it, expect } from 'vitest';
import { computeOrderTotals } from './totals';

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

  it('aplica recargo de hora pico (zone.recargo) cuando now está en el rango', () => {
    const r = computeOrderTotals({
      items: [{ productId: 'p01', qty: 1 }],
      products: PRODUCTS,
      zone: ZONE,
      settings: SETTINGS,
      now: PEAK,
    });
    expect(r.peakSurcharge).toBe(1500);
    expect(r.delivery).toBe(4500 + 1500);
    expect(r.total).toBe(28000 + 4500 + 1500);
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

  it('sin zona: delivery usa base_delivery_fee de settings y no hay recargo', () => {
    const r = computeOrderTotals({
      items: [{ productId: 'p01', qty: 1 }],
      products: PRODUCTS,
      zone: null,
      settings: SETTINGS,
      now: PEAK,
    });
    expect(r.delivery).toBe(4500);
    expect(r.peakSurcharge).toBe(0);
    expect(r.total).toBe(28000 + 4500);
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
  });
});

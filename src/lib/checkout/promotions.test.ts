import { describe, it, expect } from 'vitest';
import { evaluatePromotion, resolveAutomaticPromotion, type PromotionRow } from './promotions';
import type { TotalsProduct } from './totals';

const PRODUCTS: TotalsProduct[] = [
  { id: 'p01', name: 'Pastrami',  price: 29000, available: true },
  { id: 'p02', name: 'Cubano',    price: 27000, available: true },
  { id: 'p03', name: 'Brownie',   price: 12000, available: true },
  { id: 'p99', name: 'Agotado',   price: 10000, available: false },
];

function basePromo(over: Partial<PromotionRow> = {}): PromotionRow {
  return {
    id: 'pr1',
    kind: 'product',
    name: 'Promo',
    description: null,
    discount_type: 'percent',
    discount_value: 20,
    min_subtotal: 0,
    config: {},
    active: true,
    starts_at: null,
    ends_at: null,
    ...over,
  };
}

// Miércoles (4=jueves no, 3=miércoles en JS getDay) a las 14:00 Bogotá.
const WED_14 = new Date('2026-06-03T19:00:00.000Z'); // UTC-5 ⇒ 14:00 Bogotá
const MON_10 = new Date('2026-06-01T15:00:00.000Z'); // 10:00 Bogotá, lunes

describe('evaluatePromotion — percent', () => {
  it('20% sobre carrito completo cuando no hay restricción de producto', () => {
    const promo = basePromo({ discount_type: 'percent', discount_value: 20 });
    const items = [{ productId: 'p01', qty: 2 }]; // 58.000
    const d = evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 58000, now: WED_14 });
    expect(d).toBe(11600);
  });

  it('20% solo sobre productos elegibles (no se aplica al resto)', () => {
    const promo = basePromo({
      discount_type: 'percent',
      discount_value: 20,
      config: { product_ids: ['p01'] },
    });
    const items = [
      { productId: 'p01', qty: 1 }, // 29.000 elegible
      { productId: 'p02', qty: 1 }, // 27.000 no elegible
    ];
    const d = evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 56000, now: WED_14 });
    expect(d).toBe(5800);
  });

  it('redondea hacia abajo (Math.floor)', () => {
    const promo = basePromo({ discount_type: 'percent', discount_value: 15 });
    const items = [{ productId: 'p01', qty: 1 }]; // 29.000 * .15 = 4350
    const d = evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 29000, now: WED_14 });
    expect(d).toBe(4350);
  });

  it('clamp del % a 0-100', () => {
    const promo = basePromo({ discount_type: 'percent', discount_value: 150 });
    const items = [{ productId: 'p01', qty: 1 }];
    const d = evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 29000, now: WED_14 });
    expect(d).toBe(29000);
  });
});

describe('evaluatePromotion — fixed', () => {
  it('descuenta el monto fijo si llega al subtotal elegible', () => {
    const promo = basePromo({ discount_type: 'fixed', discount_value: 5000 });
    const items = [{ productId: 'p01', qty: 1 }];
    const d = evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 29000, now: WED_14 });
    expect(d).toBe(5000);
  });

  it('no descuenta más que el subtotal elegible (evita totales negativos)', () => {
    const promo = basePromo({
      discount_type: 'fixed',
      discount_value: 100000,
      config: { product_ids: ['p03'] }, // brownie 12.000
    });
    const items = [{ productId: 'p03', qty: 1 }];
    const d = evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 12000, now: WED_14 });
    expect(d).toBe(12000);
  });
});

describe('evaluatePromotion — free_item', () => {
  it('descuenta el precio del elegible más barato', () => {
    const promo = basePromo({
      discount_type: 'free_item',
      config: { product_ids: ['p01', 'p03'] }, // pastrami 29k, brownie 12k
    });
    const items = [
      { productId: 'p01', qty: 1 },
      { productId: 'p03', qty: 1 },
    ];
    const d = evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 41000, now: WED_14 });
    expect(d).toBe(12000); // el brownie es el más barato
  });

  it('sin elegibles en el carrito ⇒ 0', () => {
    const promo = basePromo({
      discount_type: 'free_item',
      config: { product_ids: ['p99'] }, // agotado
    });
    const items = [{ productId: 'p01', qty: 1 }];
    const d = evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 29000, now: WED_14 });
    expect(d).toBe(0);
  });
});

describe('evaluatePromotion — two_for_one', () => {
  it('2 unidades elegibles ⇒ descuenta 1 (gratis la más barata)', () => {
    const promo = basePromo({
      discount_type: 'two_for_one',
      config: { product_ids: ['p01', 'p02'] }, // pastrami 29, cubano 27
    });
    const items = [
      { productId: 'p01', qty: 1 },
      { productId: 'p02', qty: 1 },
    ];
    const d = evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 56000, now: WED_14 });
    expect(d).toBe(27000);
  });

  it('4 unidades elegibles ⇒ descuenta 2 más baratas', () => {
    const promo = basePromo({
      discount_type: 'two_for_one',
      config: { product_ids: ['p01', 'p02'] },
    });
    const items = [
      { productId: 'p01', qty: 2 }, // 29k x2
      { productId: 'p02', qty: 2 }, // 27k x2
    ];
    const d = evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 112000, now: WED_14 });
    expect(d).toBe(54000); // 27k + 27k
  });

  it('1 unidad ⇒ 0 (no hay par)', () => {
    const promo = basePromo({
      discount_type: 'two_for_one',
      config: { product_ids: ['p01'] },
    });
    const items = [{ productId: 'p01', qty: 1 }];
    const d = evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 29000, now: WED_14 });
    expect(d).toBe(0);
  });
});

describe('evaluatePromotion — guards', () => {
  it('no activa ⇒ 0', () => {
    const promo = basePromo({ active: false });
    const items = [{ productId: 'p01', qty: 1 }];
    expect(evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 29000, now: WED_14 })).toBe(0);
  });

  it('subtotal < min_subtotal ⇒ 0', () => {
    const promo = basePromo({ min_subtotal: 100000 });
    const items = [{ productId: 'p01', qty: 1 }];
    expect(evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 29000, now: WED_14 })).toBe(0);
  });

  it('fuera de la ventana de calendario (starts_at futuro) ⇒ 0', () => {
    const promo = basePromo({ starts_at: '2099-01-01T00:00:00Z' });
    const items = [{ productId: 'p01', qty: 1 }];
    expect(evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 29000, now: WED_14 })).toBe(0);
  });

  it('fuera de la ventana de calendario (ends_at pasado) ⇒ 0', () => {
    const promo = basePromo({ ends_at: '2020-01-01T00:00:00Z' });
    const items = [{ productId: 'p01', qty: 1 }];
    expect(evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 29000, now: WED_14 })).toBe(0);
  });

  it('producto agotado en el carrito no cuenta como elegible', () => {
    const promo = basePromo({
      discount_type: 'percent',
      discount_value: 50,
      config: { product_ids: ['p99'] },
    });
    const items = [{ productId: 'p99', qty: 1 }];
    expect(evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 0, now: WED_14 })).toBe(0);
  });
});

describe('evaluatePromotion — weekday', () => {
  it('aplica solo el día configurado (miércoles=3)', () => {
    const promo = basePromo({
      kind: 'weekday',
      discount_type: 'percent',
      discount_value: 10,
      config: { weekdays: [3] },
    });
    const items = [{ productId: 'p01', qty: 1 }];
    // Miércoles: aplica
    expect(evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 29000, now: WED_14 })).toBe(2900);
    // Lunes: no aplica
    expect(evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 29000, now: MON_10 })).toBe(0);
  });

  it('respeta ventana horaria HH:MM (solo después de 12:00)', () => {
    const promo = basePromo({
      kind: 'weekday',
      discount_type: 'percent',
      discount_value: 10,
      config: { weekdays: [3], starts_hhmm: '12:00', ends_hhmm: '23:00' },
    });
    const items = [{ productId: 'p01', qty: 1 }];
    // Miércoles 14:00 ⇒ dentro
    expect(evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 29000, now: WED_14 })).toBe(2900);
    // Miércoles 09:00 ⇒ fuera
    const wedEarly = new Date('2026-06-03T14:00:00.000Z'); // 09:00 Bogotá
    expect(evaluatePromotion(promo, { items, products: PRODUCTS, subtotal: 29000, now: wedEarly })).toBe(0);
  });
});

describe('resolveAutomaticPromotion', () => {
  it('elige la promo con mayor descuento entre varias aplicables', () => {
    const items = [{ productId: 'p01', qty: 2 }]; // 58.000
    const p10 = basePromo({ id: 'p10', name: '10%', discount_value: 10 });
    const p25 = basePromo({ id: 'p25', name: '25%', discount_value: 25 });
    const pFijo = basePromo({ id: 'pfix', name: '$5k off', discount_type: 'fixed', discount_value: 5000 });
    const result = resolveAutomaticPromotion({
      items,
      products: PRODUCTS,
      subtotal: 58000,
      now: WED_14,
      promotions: [p10, p25, pFijo],
    });
    expect(result?.promotion.id).toBe('p25');
    expect(result?.discount).toBe(14500);
  });

  it('ninguna aplica ⇒ null', () => {
    const items = [{ productId: 'p01', qty: 1 }];
    const noMatch = basePromo({ kind: 'weekday', config: { weekdays: [0] } }); // domingo
    const result = resolveAutomaticPromotion({
      items,
      products: PRODUCTS,
      subtotal: 29000,
      now: WED_14, // miércoles
      promotions: [noMatch],
    });
    expect(result).toBeNull();
  });

  it('lista de promos vacía ⇒ null', () => {
    const result = resolveAutomaticPromotion({
      items: [{ productId: 'p01', qty: 1 }],
      products: PRODUCTS,
      subtotal: 29000,
      now: WED_14,
      promotions: [],
    });
    expect(result).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { buildCatalog, emptyCart, classifyOrder } from './shape';

describe('buildCatalog', () => {
  it('agrupa productos por categoría en la forma del contrato', () => {
    const catalog = buildCatalog([
      { id: 'p01', name: 'Pastrami Bros', price: 28000, cat: 'Sándwiches', img: 'https://cdn/p01.jpg' },
      { id: 'p02', name: 'Italian Bro', price: 30000, cat: 'Sándwiches', img: null },
      { id: 'b03', name: 'Limonada', price: 4500, cat: 'Bebidas', img: null },
    ]);
    expect(catalog).toEqual({
      categories: [
        {
          cat: 'Sándwiches',
          items: [
            { id: 'p01', name: 'Pastrami Bros', price: 28000, cat: 'Sándwiches', img: 'https://cdn/p01.jpg' },
            { id: 'p02', name: 'Italian Bro', price: 30000, cat: 'Sándwiches', img: null },
          ],
        },
        {
          cat: 'Bebidas',
          items: [{ id: 'b03', name: 'Limonada', price: 4500, cat: 'Bebidas', img: null }],
        },
      ],
    });
  });

  it('catálogo vacío', () => {
    expect(buildCatalog([])).toEqual({ categories: [] });
  });
});

describe('emptyCart', () => {
  it('devuelve carrito vacío con totales en 0', () => {
    expect(emptyCart()).toEqual({
      items: [],
      subtotal: 0,
      delivery: 0,
      peakSurcharge: 0,
      total: 0,
    });
  });
});

describe('classifyOrder', () => {
  const NOW = new Date('2026-05-31T20:00:00.000Z');

  it('null ⇒ no_encontrada', () => {
    expect(classifyOrder(null, NOW)).toBe('no_encontrada');
  });

  it('borrador no vencida ⇒ valida', () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    expect(classifyOrder({ status: 'borrador', expires_at: future }, NOW)).toBe('valida');
  });

  it('borrador vencida ⇒ expirada', () => {
    const past = new Date(NOW.getTime() - 60_000).toISOString();
    expect(classifyOrder({ status: 'borrador', expires_at: past }, NOW)).toBe('expirada');
  });

  it('borrador sin expires_at ⇒ valida (no caduca por dato faltante)', () => {
    expect(classifyOrder({ status: 'borrador', expires_at: null }, NOW)).toBe('valida');
  });

  it('estado expirado ⇒ expirada', () => {
    expect(classifyOrder({ status: 'expirado', expires_at: null }, NOW)).toBe('expirada');
  });

  it('estado pagado/nuevo/cocina ⇒ ya_usada', () => {
    expect(classifyOrder({ status: 'pagado', expires_at: null }, NOW)).toBe('ya_usada');
    expect(classifyOrder({ status: 'nuevo', expires_at: null }, NOW)).toBe('ya_usada');
    expect(classifyOrder({ status: 'cocina', expires_at: null }, NOW)).toBe('ya_usada');
  });
});

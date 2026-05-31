import { describe, it, expect, afterEach } from 'vitest';
import { isStorefrontSelfCors, isPublicPath, allowedOrigins, isAllowedOrigin } from './access';

describe('isStorefrontSelfCors', () => {
  it('las rutas /api/checkout/* manejan su propio CORS (passthrough)', () => {
    expect(isStorefrontSelfCors('/api/checkout/sessions')).toBe(true);
    expect(isStorefrontSelfCors('/api/checkout/7254aa50-fa06')).toBe(true);
    expect(isStorefrontSelfCors('/api/checkout/abc/cart')).toBe(true);
    expect(isStorefrontSelfCors('/api/checkout/abc/pay')).toBe(true);
  });

  it('otras rutas NO son self-cors (las maneja el middleware)', () => {
    expect(isStorefrontSelfCors('/api/orders')).toBe(false);
    expect(isStorefrontSelfCors('/api/zones')).toBe(false);
    expect(isStorefrontSelfCors('/api/products/available')).toBe(false);
  });
});

describe('isPublicPath', () => {
  it('zones y products/available son públicas (el storefront los puede pedir aparte)', () => {
    expect(isPublicPath('/api/zones', 'GET')).toBe(true);
    expect(isPublicPath('/api/products/available', 'GET')).toBe(true);
  });

  it('checkout es público (no requiere sesión admin)', () => {
    expect(isPublicPath('/api/checkout/sessions', 'POST')).toBe(true);
    expect(isPublicPath('/api/checkout/o1/cart', 'PUT')).toBe(true);
  });

  it('orders POST es público (lo llama el bot), GET es privado (kanban admin)', () => {
    expect(isPublicPath('/api/orders', 'POST')).toBe(true);
    expect(isPublicPath('/api/orders', 'GET')).toBe(false);
  });

  it('rutas admin siguen privadas', () => {
    expect(isPublicPath('/api/dashboard/today', 'GET')).toBe(false);
    expect(isPublicPath('/api/orders/o1/status', 'PATCH')).toBe(false);
  });
});

describe('allowedOrigins / isAllowedOrigin', () => {
  const ORIG = process.env.STOREFRONT_ORIGIN;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.STOREFRONT_ORIGIN;
    else process.env.STOREFRONT_ORIGIN = ORIG;
  });

  it('incluye localhost:5173 por defecto y rechaza orígenes desconocidos', () => {
    delete process.env.STOREFRONT_ORIGIN;
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isAllowedOrigin('https://evil.example.com')).toBe(false);
    expect(isAllowedOrigin(null)).toBe(false);
  });

  it('incluye STOREFRONT_ORIGIN cuando está configurado (producción)', () => {
    process.env.STOREFRONT_ORIGIN = 'https://tienda.brosandsubs.com';
    expect(allowedOrigins()).toContain('https://tienda.brosandsubs.com');
    expect(isAllowedOrigin('https://tienda.brosandsubs.com')).toBe(true);
  });
});

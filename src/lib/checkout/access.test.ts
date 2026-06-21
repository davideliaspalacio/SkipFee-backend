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
  it('products/available sigue pública (catálogo de la tienda por empresa)', () => {
    expect(isPublicPath('/api/products/available', 'GET')).toBe(true);
  });

  it('webhooks por empresa son públicos (el secreto es la firma del webhook)', () => {
    expect(isPublicPath('/api/webhooks/kapso/bros-and-subs', 'POST')).toBe(true);
    expect(isPublicPath('/api/webhooks/wompi/bros-and-subs', 'POST')).toBe(true);
  });

  it('checkout es público (no requiere sesión admin)', () => {
    expect(isPublicPath('/api/checkout/sessions', 'POST')).toBe(true);
    expect(isPublicPath('/api/checkout/o1/cart', 'PUT')).toBe(true);
  });

  it('leads POST es público (landing de marketing, capa plataforma)', () => {
    expect(isPublicPath('/api/leads', 'POST')).toBe(true);
  });

  it('multi-empresa: zones/quotes/orders/promotions ya NO son públicas (movidas a [companyId])', () => {
    expect(isPublicPath('/api/zones', 'GET')).toBe(false);
    expect(isPublicPath('/api/orders', 'POST')).toBe(false);
    expect(isPublicPath('/api/quotes', 'POST')).toBe(false);
    expect(isPublicPath('/api/promotions/active', 'GET')).toBe(false);
  });

  it('rutas admin siguen privadas', () => {
    expect(isPublicPath('/api/dashboard/today', 'GET')).toBe(false);
    expect(isPublicPath('/api/orders/o1/status', 'PATCH')).toBe(false);
    expect(isPublicPath('/api/platform/companies', 'POST')).toBe(false);
  });
});

describe('allowedOrigins / isAllowedOrigin', () => {
  const ORIG = process.env.STOREFRONT_ORIGIN;
  const ORIG_EXTRA = process.env.EXTRA_CORS_ORIGINS;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.STOREFRONT_ORIGIN;
    else process.env.STOREFRONT_ORIGIN = ORIG;
    if (ORIG_EXTRA === undefined) delete process.env.EXTRA_CORS_ORIGINS;
    else process.env.EXTRA_CORS_ORIGINS = ORIG_EXTRA;
  });

  it('incluye localhost:5173 por defecto y rechaza orígenes desconocidos', () => {
    delete process.env.STOREFRONT_ORIGIN;
    delete process.env.EXTRA_CORS_ORIGINS;
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

  it('suma EXTRA_CORS_ORIGINS (lista por comas, con trim y dedup)', () => {
    delete process.env.STOREFRONT_ORIGIN;
    process.env.EXTRA_CORS_ORIGINS = 'https://panel.com, http://localhost:4173 ,http://localhost:5173';
    const origins = allowedOrigins();
    expect(origins).toContain('https://panel.com');
    expect(origins).toContain('http://localhost:4173');
    expect(isAllowedOrigin('https://panel.com')).toBe(true);
    expect(origins.filter(o => o === 'http://localhost:5173')).toHaveLength(1); // dedup con dev
  });
});

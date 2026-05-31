import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { corsHeaders, preflight, jsonWithCors } from './cors';

describe('cors helpers', () => {
  const ORIGINAL = process.env.STOREFRONT_ORIGIN;
  beforeEach(() => {
    process.env.STOREFRONT_ORIGIN = 'http://localhost:5173';
  });
  afterEach(() => {
    process.env.STOREFRONT_ORIGIN = ORIGINAL;
  });

  it('corsHeaders incluye el origen del storefront y métodos', () => {
    const h = corsHeaders();
    expect(h['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    expect(h['Access-Control-Allow-Methods']).toContain('OPTIONS');
    expect(h['Access-Control-Allow-Methods']).toContain('PUT');
    expect(h['Access-Control-Allow-Headers']).toContain('Content-Type');
    expect(h['Vary']).toContain('Origin');
  });

  it('cae a "*" si STOREFRONT_ORIGIN no está seteado', () => {
    delete process.env.STOREFRONT_ORIGIN;
    expect(corsHeaders()['Access-Control-Allow-Origin']).toBe('*');
  });

  it('preflight responde 204 con headers CORS', () => {
    const res = preflight();
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });

  it('jsonWithCors adjunta headers CORS y el status pedido', async () => {
    const res = jsonWithCors({ ok: true, foo: 1 }, 201);
    expect(res.status).toBe(201);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(await res.json()).toEqual({ ok: true, foo: 1 });
  });
});

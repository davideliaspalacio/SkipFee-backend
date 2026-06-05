import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Controla el Origin que ve cors.ts. Por defecto "fuera de scope" (como cuando el
// helper corre sin request, p. ej. en estos tests unitarios) → STOREFRONT_ORIGIN.
const headersMock = vi.fn();
vi.mock('next/headers', () => ({ headers: () => headersMock() }));

import { corsHeaders, preflight, jsonWithCors } from './cors';

const ORIGINAL_SF = process.env.STOREFRONT_ORIGIN;
const ORIGINAL_EXTRA = process.env.EXTRA_CORS_ORIGINS;

function withRequestOrigin(origin: string) {
  headersMock.mockReturnValue(new Headers({ origin }));
}
function withoutRequestScope() {
  headersMock.mockImplementation(() => {
    throw new Error('headers() outside request scope');
  });
}

beforeEach(() => {
  process.env.STOREFRONT_ORIGIN = 'http://localhost:5173';
  delete process.env.EXTRA_CORS_ORIGINS;
  withoutRequestScope();
});
afterEach(() => {
  if (ORIGINAL_SF === undefined) delete process.env.STOREFRONT_ORIGIN;
  else process.env.STOREFRONT_ORIGIN = ORIGINAL_SF;
  if (ORIGINAL_EXTRA === undefined) delete process.env.EXTRA_CORS_ORIGINS;
  else process.env.EXTRA_CORS_ORIGINS = ORIGINAL_EXTRA;
  vi.clearAllMocks();
});

describe('cors helpers', () => {
  it('sin request scope → usa STOREFRONT_ORIGIN y métodos', async () => {
    const h = await corsHeaders();
    expect(h['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    expect(h['Access-Control-Allow-Methods']).toContain('OPTIONS');
    expect(h['Access-Control-Allow-Methods']).toContain('PUT');
    expect(h['Access-Control-Allow-Headers']).toContain('Content-Type');
    expect(h['Vary']).toContain('Origin');
  });

  it('cae a "*" si STOREFRONT_ORIGIN no está seteado', async () => {
    delete process.env.STOREFRONT_ORIGIN;
    expect((await corsHeaders())['Access-Control-Allow-Origin']).toBe('*');
  });

  it('refleja el Origin del request si está permitido (localhost dev) aunque STOREFRONT_ORIGIN sea prod', async () => {
    process.env.STOREFRONT_ORIGIN = 'https://tienda.brosandsubs.com';
    withRequestOrigin('http://localhost:5173'); // está en DEV_ORIGINS
    expect((await corsHeaders())['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
  });

  it('NO refleja un Origin desconocido → cae a STOREFRONT_ORIGIN', async () => {
    process.env.STOREFRONT_ORIGIN = 'https://tienda.brosandsubs.com';
    withRequestOrigin('https://evil.example.com');
    expect((await corsHeaders())['Access-Control-Allow-Origin']).toBe('https://tienda.brosandsubs.com');
  });

  it('refleja un Origin de EXTRA_CORS_ORIGINS', async () => {
    process.env.STOREFRONT_ORIGIN = 'https://tienda.brosandsubs.com';
    process.env.EXTRA_CORS_ORIGINS = 'http://localhost:4173';
    withRequestOrigin('http://localhost:4173');
    expect((await corsHeaders())['Access-Control-Allow-Origin']).toBe('http://localhost:4173');
  });

  it('preflight responde 204 con headers CORS', async () => {
    const res = await preflight();
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });

  it('jsonWithCors adjunta headers CORS y el status pedido', async () => {
    const res = await jsonWithCors({ ok: true, foo: 1 }, 201);
    expect(res.status).toBe(201);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(await res.json()).toEqual({ ok: true, foo: 1 });
  });
});

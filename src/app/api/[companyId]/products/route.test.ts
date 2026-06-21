import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeSupabaseStub, jsonRequest } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const insertCapture = vi.fn();

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// `withTenant` se mockea para inyectar un `ctx` falso (db = stub, company fija)
// y exponer el handler interno con la firma (request, ctx, params). Así el test
// ejercita la lógica de negocio sin montar auth/RLS reales.
vi.mock('@/lib/tenant', () => ({
  withTenant: (handler: (req: NextRequest, ctx: unknown, params: unknown) => unknown) =>
    (req: NextRequest, params: { companyId: string }) =>
      handler(req, { db: supabaseStub.client, company: { id: COMPANY_ID, slug: 'bros-and-subs' } }, params),
}));

import { POST as POST_ROUTE } from './route';

// El mock de `withTenant` cambia la firma en runtime a (request, params).
const POST = POST_ROUTE as unknown as (
  req: NextRequest,
  params: { companyId: string },
) => Promise<Response>;

const params = { companyId: 'bros-and-subs' };

beforeEach(() => {
  insertCapture.mockReset();
  supabaseStub = makeSupabaseStub({
    products: {
      onInsert: (payload) => {
        insertCapture(payload);
        const p = payload as Record<string, unknown>;
        return {
          data: {
            id: 'p-new-uuid',
            name: p.name,
            price: p.price,
            cat: p.cat,
            available: p.available ?? true,
            img: p.img ?? '',
            sold: 0,
          },
        };
      },
    },
  });
});

describe('POST /api/:companyId/products', () => {
  it('crea producto con todos los campos requeridos (scopeado a la empresa)', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/bros-and-subs/products', 'POST', {
      name: 'Pastrami Bros',
      price: 28000,
      cat: 'Sándwiches',
    }), params);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.product.id).toBe('p-new-uuid');
    expect(body.product.name).toBe('Pastrami Bros');
    expect(body.product.price).toBe(28000);
    expect(body.product.sold).toBe(0);
    expect(body.product.available).toBe(true);

    const inserted = insertCapture.mock.calls[0][0];
    expect(inserted).toMatchObject({
      company_id: COMPANY_ID,
      name: 'Pastrami Bros',
      price: 28000,
      cat: 'Sándwiches',
      available: true,
      img: '',
      sold: 0,
    });
  });

  it('acepta img y available opcional', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/bros-and-subs/products', 'POST', {
      name: 'X',
      price: 1000,
      cat: 'Cat',
      available: false,
      img: 'https://example.com/foto.jpg',
    }), params);
    expect(res.status).toBe(201);
    const inserted = insertCapture.mock.calls[0][0];
    expect(inserted.available).toBe(false);
    expect(inserted.img).toBe('https://example.com/foto.jpg');
  });

  it('400 si falta nombre', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/bros-and-subs/products', 'POST', {
      price: 1000, cat: 'X',
    }), params);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('400 si precio es negativo', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/bros-and-subs/products', 'POST', {
      name: 'X', price: -1, cat: 'X',
    }), params);
    expect(res.status).toBe(400);
  });

  it('permite precio 0 (productos de regalo, categoría "Regalo")', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/bros-and-subs/products', 'POST', {
      name: 'Postre de regalo', price: 0, cat: 'Regalo',
    }), params);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.product.price).toBe(0);
  });

  it('400 si JSON inválido', async () => {
    const req = new Request('http://localhost:3000/api/bros-and-subs/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const res = await POST(req as never, params);
    expect(res.status).toBe(400);
  });
});

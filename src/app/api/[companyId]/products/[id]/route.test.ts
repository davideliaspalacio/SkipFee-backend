import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeSupabaseStub, jsonRequest } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const updateCapture = vi.fn();
const updateFilters = vi.fn();
const deleteCapture = vi.fn();
const storageRemoveMock = vi.fn();

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// `withTenant` se mockea para inyectar un `ctx` falso. `ctx.db` lleva el stub
// + un `storage` falso (el handler usa `ctx.db.storage`, no `supabaseAdmin`).
vi.mock('@/lib/tenant', () => ({
  withTenant: (handler: (req: NextRequest, ctx: unknown, params: unknown) => unknown) =>
    (req: NextRequest, params: { companyId: string; id: string }) =>
      handler(
        req,
        {
          db: {
            ...(supabaseStub.client as Record<string, unknown>),
            storage: {
              from: () => ({
                remove: (paths: string[]) => {
                  storageRemoveMock(paths);
                  return Promise.resolve({ error: null });
                },
              }),
            },
          },
          company: { id: COMPANY_ID, slug: 'bros-and-subs' },
        },
        params,
      ),
}));

import { PATCH as PATCH_ROUTE, DELETE as DELETE_ROUTE } from './route';

const PATCH = PATCH_ROUTE as unknown as (
  req: NextRequest,
  params: { companyId: string; id: string },
) => Promise<Response>;
const DELETE = DELETE_ROUTE as unknown as (
  req: NextRequest,
  params: { companyId: string; id: string },
) => Promise<Response>;

function params(id: string) {
  return { companyId: 'bros-and-subs', id };
}

beforeEach(() => {
  updateCapture.mockReset();
  updateFilters.mockReset();
  deleteCapture.mockReset();
  storageRemoveMock.mockReset();
});

describe('PATCH /api/:companyId/products/:id', () => {
  beforeEach(() => {
    supabaseStub = makeSupabaseStub({
      products: {
        single: { id: 'p01', name: 'Pastrami', price: 28000, cat: 'Sándwiches', sold: 1, available: true, img: '' },
        onUpdate: (payload, filters) => {
          updateCapture(payload);
          updateFilters(filters);
          return { data: { id: 'p01', ...(payload as object) } };
        },
      },
    });
  });

  it('acepta available (compat) y scopea por company_id', async () => {
    const res = await PATCH(
      jsonRequest('http://localhost:3000/api/bros-and-subs/products/p01', 'PATCH', { available: false }),
      params('p01'),
    );
    expect(res.status).toBe(200);
    expect(updateCapture).toHaveBeenCalledWith({ available: false });
    expect(updateFilters.mock.calls[0][0].company_id).toBe(COMPANY_ID);
  });

  it('acepta cat, img, sold (extendido)', async () => {
    const res = await PATCH(
      jsonRequest('http://localhost:3000/api/bros-and-subs/products/p01', 'PATCH', {
        cat: 'Bebidas',
        img: 'https://x.supabase.co/storage/v1/object/public/product-images/p01/1.jpg',
        sold: 42,
      }),
      params('p01'),
    );
    expect(res.status).toBe(200);
    expect(updateCapture).toHaveBeenCalledWith({
      cat: 'Bebidas',
      img: 'https://x.supabase.co/storage/v1/object/public/product-images/p01/1.jpg',
      sold: 42,
    });
  });

  it('400 si body vacío', async () => {
    const res = await PATCH(
      jsonRequest('http://localhost:3000/api/bros-and-subs/products/p01', 'PATCH', {}),
      params('p01'),
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/:companyId/products/:id', () => {
  it('archiva el producto y borra la imagen del bucket (path con prefijo de empresa)', async () => {
    supabaseStub = makeSupabaseStub({
      products: {
        single: {
          id: 'p01',
          img: `https://x.supabase.co/storage/v1/object/public/product-images/${COMPANY_ID}/p01/1748000000.jpg`,
        },
        onUpdate: (payload, filters) => {
          deleteCapture(filters);
          updateCapture(payload);
          return {};
        },
      },
    });
    const res = await DELETE(new Request('http://localhost:3000/api/bros-and-subs/products/p01') as never, params('p01'));
    expect(res.status).toBe(200);
    expect(deleteCapture.mock.calls[0][0].company_id).toBe(COMPANY_ID);
    expect(storageRemoveMock).toHaveBeenCalledWith([`${COMPANY_ID}/p01/1748000000.jpg`]);
  });

  it('archiva el producto sin tocar bucket si img es URL externa', async () => {
    supabaseStub = makeSupabaseStub({
      products: {
        single: { id: 'p01', img: 'https://loremflickr.com/480/360/foo' },
        onUpdate: () => ({}),
      },
    });
    const res = await DELETE(new Request('http://localhost:3000/api/bros-and-subs/products/p01') as never, params('p01'));
    expect(res.status).toBe(200);
    expect(storageRemoveMock).not.toHaveBeenCalled();
  });

  it('404 si producto no existe', async () => {
    supabaseStub = makeSupabaseStub({ products: { single: null } });
    const res = await DELETE(new Request('http://localhost:3000/api/bros-and-subs/products/missing') as never, params('missing'));
    expect(res.status).toBe(404);
  });
});

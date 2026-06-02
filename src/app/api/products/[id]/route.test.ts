import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub, jsonRequest, asyncParams } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const updateCapture = vi.fn();
const deleteCapture = vi.fn();
const storageRemoveMock = vi.fn();

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => ({
    ...(supabaseStub.client as Record<string, unknown>),
    storage: {
      from: () => ({
        remove: (paths: string[]) => {
          storageRemoveMock(paths);
          return Promise.resolve({ error: null });
        },
      }),
    },
  }),
}));

import { PATCH, DELETE } from './route';

beforeEach(() => {
  updateCapture.mockReset();
  deleteCapture.mockReset();
  storageRemoveMock.mockReset();
});

describe('PATCH /api/products/:id', () => {
  beforeEach(() => {
    supabaseStub = makeSupabaseStub({
      products: {
        single: { id: 'p01', name: 'Pastrami', price: 28000, cat: 'Sándwiches', sold: 1, available: true, img: '' },
        onUpdate: (payload) => {
          updateCapture(payload);
          return { data: { id: 'p01', ...(payload as object) } };
        },
      },
    });
  });

  it('acepta available (compat)', async () => {
    const res = await PATCH(
      jsonRequest('http://localhost:3000/api/products/p01', 'PATCH', { available: false }),
      asyncParams({ id: 'p01' }),
    );
    expect(res.status).toBe(200);
    expect(updateCapture).toHaveBeenCalledWith({ available: false });
  });

  it('acepta cat, img, sold (extendido)', async () => {
    const res = await PATCH(
      jsonRequest('http://localhost:3000/api/products/p01', 'PATCH', {
        cat: 'Bebidas',
        img: 'https://x.supabase.co/storage/v1/object/public/product-images/p01/1.jpg',
        sold: 42,
      }),
      asyncParams({ id: 'p01' }),
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
      jsonRequest('http://localhost:3000/api/products/p01', 'PATCH', {}),
      asyncParams({ id: 'p01' }),
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/products/:id', () => {
  it('borra el producto y la imagen del bucket si tenía una', async () => {
    supabaseStub = makeSupabaseStub({
      products: {
        single: {
          id: 'p01',
          img: 'https://x.supabase.co/storage/v1/object/public/product-images/p01/1748000000.jpg',
        },
        onDelete: (filters) => {
          deleteCapture(filters);
          return {};
        },
      },
    });
    const res = await DELETE(new Request('http://localhost:3000/api/products/p01') as never, asyncParams({ id: 'p01' }));
    expect(res.status).toBe(200);
    expect(deleteCapture).toHaveBeenCalled();
    expect(storageRemoveMock).toHaveBeenCalledWith(['p01/1748000000.jpg']);
  });

  it('borra el producto sin tocar bucket si img es URL externa', async () => {
    supabaseStub = makeSupabaseStub({
      products: {
        single: { id: 'p01', img: 'https://loremflickr.com/480/360/foo' },
        onDelete: () => ({}),
      },
    });
    const res = await DELETE(new Request('http://localhost:3000/api/products/p01') as never, asyncParams({ id: 'p01' }));
    expect(res.status).toBe(200);
    expect(storageRemoveMock).not.toHaveBeenCalled();
  });

  it('404 si producto no existe', async () => {
    supabaseStub = makeSupabaseStub({ products: { single: null } });
    const res = await DELETE(new Request('http://localhost:3000/api/products/missing') as never, asyncParams({ id: 'missing' }));
    expect(res.status).toBe(404);
  });
});

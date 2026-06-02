import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub, jsonRequest } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const insertCapture = vi.fn();

vi.mock('@/lib/db', () => ({ supabaseAdmin: () => supabaseStub.client }));

import { POST } from './route';

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

describe('POST /api/products', () => {
  it('crea producto con todos los campos requeridos', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/products', 'POST', {
      name: 'Pastrami Bros',
      price: 28000,
      cat: 'Sándwiches',
    }));
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
      name: 'Pastrami Bros',
      price: 28000,
      cat: 'Sándwiches',
      available: true,
      img: '',
      sold: 0,
    });
  });

  it('acepta img y available opcional', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/products', 'POST', {
      name: 'X',
      price: 1000,
      cat: 'Cat',
      available: false,
      img: 'https://example.com/foto.jpg',
    }));
    expect(res.status).toBe(201);
    const inserted = insertCapture.mock.calls[0][0];
    expect(inserted.available).toBe(false);
    expect(inserted.img).toBe('https://example.com/foto.jpg');
  });

  it('400 si falta nombre', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/products', 'POST', {
      price: 1000, cat: 'X',
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('400 si precio no es positivo', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/products', 'POST', {
      name: 'X', price: 0, cat: 'X',
    }));
    expect(res.status).toBe(400);
  });

  it('400 si JSON inválido', async () => {
    const req = new Request('http://localhost:3000/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });
});

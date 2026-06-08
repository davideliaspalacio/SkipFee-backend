import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub, jsonRequest } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const insertCapture = vi.fn();

vi.mock('@/lib/db', () => ({ supabaseAdmin: () => supabaseStub.client }));

import { GET, POST } from './route';

beforeEach(() => {
  insertCapture.mockReset();
  supabaseStub = makeSupabaseStub({
    promotions: {
      rows: [
        {
          id: 'pr1', kind: 'weekday', name: 'Miércoles brownie', description: 'gratis',
          discount_type: 'free_item', discount_value: 0, min_subtotal: 35000,
          config: { weekdays: [3], product_ids: ['p03'] }, active: true, archived: false,
          starts_at: null, ends_at: null,
        },
      ],
      onInsert: (payload) => {
        insertCapture(payload);
        const p = payload as Record<string, unknown>;
        return {
          data: { id: 'pr-new', created_at: 'now', updated_at: 'now', ...p },
        };
      },
    },
  });
});

describe('GET /api/promotions', () => {
  it('lista todas las promociones (excluyendo archivadas por defecto)', async () => {
    const res = await GET(new Request('http://localhost:3000/api/promotions') as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.promotions).toHaveLength(1);
    expect(body.promotions[0].id).toBe('pr1');
  });

  it('?all=1 incluye archivadas', async () => {
    const res = await GET(new Request('http://localhost:3000/api/promotions?all=1') as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

describe('POST /api/promotions', () => {
  it('crea promo kind=product con campos válidos', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/promotions', 'POST', {
      kind: 'product',
      name: '20% Pastrami',
      discount_type: 'percent',
      discount_value: 20,
      config: { product_ids: ['p01'] },
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.promotion.id).toBe('pr-new');
    expect(insertCapture.mock.calls[0][0]).toMatchObject({
      kind: 'product',
      name: '20% Pastrami',
      discount_type: 'percent',
      discount_value: 20,
      active: true,
      min_subtotal: 0,
    });
  });

  it('crea promo kind=weekday con weekdays + ventana horaria', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/promotions', 'POST', {
      kind: 'weekday',
      name: 'Jueves cerveza 2x1',
      discount_type: 'two_for_one',
      discount_value: 0,
      config: { weekdays: [4], starts_hhmm: '18:00', ends_hhmm: '23:00', product_ids: ['p17'] },
    }));
    expect(res.status).toBe(201);
    expect(insertCapture.mock.calls[0][0]).toMatchObject({
      kind: 'weekday',
      discount_type: 'two_for_one',
      config: { weekdays: [4], starts_hhmm: '18:00', ends_hhmm: '23:00', product_ids: ['p17'] },
    });
  });

  it('400 si kind=product sin product_ids', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/promotions', 'POST', {
      kind: 'product',
      name: 'X',
      discount_type: 'percent',
      discount_value: 10,
      config: {},
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors[0].message).toMatch(/Requerido/i);
  });

  it('400 si kind=weekday sin weekdays', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/promotions', 'POST', {
      kind: 'weekday',
      name: 'X',
      discount_type: 'percent',
      discount_value: 10,
      config: {},
    }));
    expect(res.status).toBe(400);
  });

  it('400 si percent fuera de 1-100', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/promotions', 'POST', {
      kind: 'product',
      name: 'X',
      discount_type: 'percent',
      discount_value: 200,
      config: { product_ids: ['p01'] },
    }));
    expect(res.status).toBe(400);
  });

  it('description vacía se persiste como null', async () => {
    await POST(jsonRequest('http://localhost:3000/api/promotions', 'POST', {
      kind: 'product',
      name: 'X',
      description: '   ',
      discount_type: 'percent',
      discount_value: 10,
      config: { product_ids: ['p01'] },
    }));
    expect(insertCapture.mock.calls[0][0].description).toBeNull();
  });
});

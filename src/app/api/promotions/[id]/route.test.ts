import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub, jsonRequest, asyncParams } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const updateCapture = vi.fn();

vi.mock('@/lib/db', () => ({ supabaseAdmin: () => supabaseStub.client }));

import { PATCH, DELETE } from './route';

beforeEach(() => {
  updateCapture.mockReset();
  supabaseStub = makeSupabaseStub({
    promotions: {
      onUpdate: (payload) => {
        updateCapture(payload);
        return {
          data: {
            id: 'pr1', kind: 'product', name: 'X', description: null,
            discount_type: 'percent', discount_value: 20, min_subtotal: 0,
            config: {}, active: true, starts_at: null, ends_at: null,
            created_at: 'x', updated_at: 'y',
            ...(payload as object),
          },
        };
      },
    },
    orders: { rows: [] }, // 0 órdenes que referencien la promo ⇒ se puede borrar
  });
});

describe('PATCH /api/promotions/:id', () => {
  it('actualiza solo campos provistos', async () => {
    const res = await PATCH(
      jsonRequest('http://localhost:3000/api/promotions/pr1', 'PATCH', { active: false }),
      asyncParams({ id: 'pr1' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(updateCapture.mock.calls[0][0]).toEqual({ active: false });
  });

  it('description vacía se persiste como null', async () => {
    await PATCH(
      jsonRequest('http://localhost:3000/api/promotions/pr1', 'PATCH', { description: '   ' }),
      asyncParams({ id: 'pr1' }),
    );
    expect(updateCapture.mock.calls[0][0].description).toBeNull();
  });

  it('400 si body vacío', async () => {
    const res = await PATCH(
      jsonRequest('http://localhost:3000/api/promotions/pr1', 'PATCH', {}),
      asyncParams({ id: 'pr1' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 si discount_value negativo', async () => {
    const res = await PATCH(
      jsonRequest('http://localhost:3000/api/promotions/pr1', 'PATCH', { discount_value: -5 }),
      asyncParams({ id: 'pr1' }),
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/promotions/:id', () => {
  it('elimina cuando no hay pedidos asociados', async () => {
    // Override del stub para que orders count = 0
    supabaseStub = makeSupabaseStub({
      orders: { rows: [] },
      promotions: { onDelete: () => ({}) },
    });
    const res = await DELETE(
      new Request('http://x') as never,
      asyncParams({ id: 'pr1' }),
    );
    expect(res.status).toBe(200);
  });

  // Nota: el test de "409 si hay pedidos" requiere stub más sofisticado de
  // count + head:true que makeSupabaseStub no soporta out-of-the-box.
  // Se cubrirá con integration test cuando montemos supabase-local.
});

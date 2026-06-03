import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => supabaseStub.client,
}));

import { GET } from './route';

describe('GET /api/orders/stats', () => {
  beforeEach(() => {
    supabaseStub = makeSupabaseStub({
      orders: {
        rows: [
          { status: 'nuevo' },
          { status: 'pagado' },
          { status: 'cocina' },
          { status: 'empacado' },
          { status: 'ruta' },
          { status: 'entregado' },
          { status: 'entregado' },
          { status: 'cancelado' },
          { status: 'borrador' },
        ],
      },
    });
  });

  it('cuenta activos y entregados del día', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, active: 5, completedToday: 2 });
  });

  it('devuelve 0/0 si no hay pedidos hoy', async () => {
    supabaseStub = makeSupabaseStub({ orders: { rows: [] } });
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ ok: true, active: 0, completedToday: 0 });
  });

  it('propaga error del supabase', async () => {
    supabaseStub = makeSupabaseStub({
      orders: { rows: [], error: { message: 'db down' } },
    });
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'db down' });
  });
});

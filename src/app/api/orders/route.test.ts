import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub, getRequest } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => supabaseStub.client,
}));

import { GET } from './route';

function orderRow(id: string, status: string) {
  return {
    id,
    order_number: 1,
    total: 1000,
    status,
    address: 'Cra 1 #2-3',
    phone: '573136913188',
    payment_method: 'Wompi · Tarjeta',
    note: null,
    lat: 6.2,
    lng: -75.5,
    created_at: new Date('2026-05-31T12:00:00.000Z').toISOString(),
    customer: { id: 'c1', name: 'Ana' },
    zone: { id: 'poblado', name: 'El Poblado' },
    items: [{ qty: 1, product: { name: 'Pastrami Bros' } }],
  };
}

describe('GET /api/orders — kanban', () => {
  beforeEach(() => {
    supabaseStub = makeSupabaseStub({
      orders: {
        rows: [
          orderRow('o1', 'pagado'),
          orderRow('o2', 'borrador'),
          orderRow('o3', 'expirado'),
          orderRow('o4', 'cocina'),
        ],
      },
    });
  });

  it('excluye órdenes en borrador y expirado', async () => {
    const res = await GET(getRequest('http://localhost:3000/api/orders'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const statuses = (body.orders as Array<{ status: string }>).map(o => o.status);
    expect(statuses).toContain('pagado');
    expect(statuses).toContain('cocina');
    expect(statuses).not.toContain('borrador');
    expect(statuses).not.toContain('expirado');
    expect(body.orders).toHaveLength(2);
  });
});

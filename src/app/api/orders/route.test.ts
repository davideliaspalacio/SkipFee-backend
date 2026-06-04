import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub, getRequest } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => supabaseStub.client,
}));

import { GET } from './route';

function orderRow(id: string, status: string, total: number | null = 1000) {
  return {
    id,
    order_number: 1,
    total,
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
          orderRow('o2', 'borrador', 5000), // carrito armado → visible "Sin pagar"
          orderRow('o3', 'expirado'),
          orderRow('o4', 'cocina'),
          orderRow('o5', 'borrador', null), // borrador vacío (aún sin carrito) → oculto
          orderRow('o6', 'pendiente_pago', 8000), // pago iniciado → visible "Sin pagar"
        ],
      },
    });
  });

  it('incluye pedidos reales + borradores con carrito; excluye expirados y borradores vacíos', async () => {
    const res = await GET(getRequest('http://localhost:3000/api/orders'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const ids = (body.orders as Array<{ id: string }>).map(o => o.id);
    expect(ids).toEqual(expect.arrayContaining(['o1', 'o2', 'o4', 'o6']));
    expect(ids).not.toContain('o3'); // expirado
    expect(ids).not.toContain('o5'); // borrador vacío (total NULL)
    expect(body.orders).toHaveLength(4);
  });

  it('muestra borrador/pendiente_pago en la columna "Nuevo" con flag unpaid', async () => {
    const res = await GET(getRequest('http://localhost:3000/api/orders'));
    const body = await res.json();
    const byId = new Map(
      (body.orders as Array<{ id: string; status: string; unpaid: boolean }>).map(o => [o.id, o]),
    );

    // Sin pagar → se colapsan a 'nuevo' y traen unpaid: true.
    expect(byId.get('o2')).toMatchObject({ status: 'nuevo', unpaid: true });
    expect(byId.get('o6')).toMatchObject({ status: 'nuevo', unpaid: true });

    // Pagados/en curso conservan su estado real y unpaid: false.
    expect(byId.get('o1')).toMatchObject({ status: 'pagado', unpaid: false });
    expect(byId.get('o4')).toMatchObject({ status: 'cocina', unpaid: false });
  });
});

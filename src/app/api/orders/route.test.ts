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
      settings: { single: { delivered_window_hours: 8 } },
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

  it('sin filtro de status: pide al server "no entregado OR dentro de la ventana"', async () => {
    // Espiamos `.or()` sobre el builder de `orders` para validar la expresión
    // que mandamos a PostgREST.
    const orSpy = vi.fn();
    // Cast a `any` para poder espiar el builder dinámicamente — el stub está
    // tipado como `unknown` a propósito.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = supabaseStub.client as any;
    const origFrom = client.from;
    client.from = (table: string) => {
      const b = origFrom(table);
      if (table === 'orders') {
        const realOr = b.or;
        b.or = (expr: string) => {
          orSpy(expr);
          return realOr(expr);
        };
      }
      return b;
    };

    const res = await GET(getRequest('http://localhost:3000/api/orders'));
    expect(res.status).toBe(200);
    expect(orSpy).toHaveBeenCalledTimes(1);
    const expr = orSpy.mock.calls[0][0] as string;
    expect(expr).toMatch(/^status\.neq\.entregado,created_at\.gte\./);
    // Cutoff ~8 h atrás (la default que stubbeamos).
    const isoMatch = expr.match(/created_at\.gte\.(.+)$/);
    expect(isoMatch).not.toBeNull();
    const cutoffMs = new Date(isoMatch![1]).getTime();
    const expected = Date.now() - 8 * 60 * 60 * 1000;
    expect(Math.abs(cutoffMs - expected)).toBeLessThan(5_000);
  });

  it('con status=entregado: aplica el cutoff con gte en lugar de or', async () => {
    const orSpy = vi.fn();
    const gteSpy = vi.fn();
    // Cast a `any` para poder espiar el builder dinámicamente — el stub está
    // tipado como `unknown` a propósito.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = supabaseStub.client as any;
    const origFrom = client.from;
    client.from = (table: string) => {
      const b = origFrom(table);
      if (table === 'orders') {
        const realOr = b.or;
        const realGte = b.gte;
        b.or = (e: string) => { orSpy(e); return realOr(e); };
        b.gte = (c: string, v: unknown) => { gteSpy(c, v); return realGte(c, v); };
      }
      return b;
    };

    await GET(getRequest('http://localhost:3000/api/orders?status=entregado'));
    expect(orSpy).not.toHaveBeenCalled();
    expect(gteSpy).toHaveBeenCalledWith('created_at', expect.any(String));
  });
});

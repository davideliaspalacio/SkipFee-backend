import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub, jsonRequest, asyncParams } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const customerUpsertCapture = vi.fn();
const orderUpdateCapture = vi.fn();

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => supabaseStub.client,
}));

import { POST, OPTIONS } from './route';

const URL = 'http://localhost:3000/api/checkout/o1/pay';

function tablesFor(orderRow: unknown) {
  return {
    orders: {
      single: orderRow,
      onUpdate: (payload: unknown) => { orderUpdateCapture(payload); return {}; },
    },
    customers: {
      onUpsert: (payload: unknown) => { customerUpsertCapture(payload); return { data: { id: 'cust-1' } }; },
      single: { id: 'cust-1' },
    },
  };
}

// Orden borrador completa (items + address + zone), lista para pagar.
function completeOrder() {
  return {
    id: 'o1',
    phone: '573136913188',
    status: 'borrador',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    address: 'Cra 1 #2-3',
    zone_id: 'poblado',
    lat: 6.2,
    lng: -75.5,
    total: 60500,
    items: [{ qty: 2, price_at_order: 28000 }],
  };
}

beforeEach(() => {
  process.env.STOREFRONT_ORIGIN = 'http://localhost:5173';
  process.env.NEXT_PUBLIC_APP_ORIGIN = 'http://localhost:3000';
  customerUpsertCapture.mockReset();
  orderUpdateCapture.mockReset();
});

describe('POST /api/checkout/:orderId/pay', () => {
  it('carrito completo ⇒ upsert customer, NO cambia estado, devuelve paymentLink + total', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(completeOrder()));
    const res = await POST(
      jsonRequest(URL, 'POST', {
        customer: { name: 'Ana Pérez', email: 'ana@mail.com' },
        paymentMethod: 'Wompi · Tarjeta',
        note: 'Sin cebolla',
      }),
      asyncParams({ orderId: 'o1' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.paymentLink).toBe('http://localhost:3000/wompi/checkout/o1');
    expect(body.total).toBe(60500);

    // upsert customer por phone
    const up = customerUpsertCapture.mock.calls[0][0];
    expect(up.phone).toBe('573136913188');
    expect(up.name).toBe('Ana Pérez');
    expect(up.email).toBe('ana@mail.com');

    // update de la orden: liga customer + payment_method + note, NO toca status
    const upd = orderUpdateCapture.mock.calls[0][0];
    expect(upd.customer_id).toBe('cust-1');
    expect(upd.payment_method).toBe('Wompi · Tarjeta');
    expect(upd.note).toBe('Sin cebolla');
    expect(upd.status).toBeUndefined();
  });

  it('paymentMethod default = "Wompi · Tarjeta" cuando no se manda', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(completeOrder()));
    const res = await POST(
      jsonRequest(URL, 'POST', { customer: { name: 'Ana' } }),
      asyncParams({ orderId: 'o1' }),
    );
    expect(res.status).toBe(200);
    const upd = orderUpdateCapture.mock.calls[0][0];
    expect(upd.payment_method).toBe('Wompi · Tarjeta');
  });

  it('sin items ⇒ 400 missing incluye "items"', async () => {
    const order = { ...completeOrder(), items: [] };
    supabaseStub = makeSupabaseStub(tablesFor(order));
    const res = await POST(jsonRequest(URL, 'POST', { customer: { name: 'Ana' } }), asyncParams({ orderId: 'o1' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.missing).toContain('items');
  });

  it('sin dirección/zona ⇒ 400 missing incluye address y zoneId', async () => {
    const order = { ...completeOrder(), address: null, zone_id: null };
    supabaseStub = makeSupabaseStub(tablesFor(order));
    const res = await POST(jsonRequest(URL, 'POST', { customer: { name: 'Ana' } }), asyncParams({ orderId: 'o1' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.missing).toEqual(expect.arrayContaining(['address', 'zoneId']));
  });

  it('sin nombre ⇒ 400 (zod o missing name)', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(completeOrder()));
    const res = await POST(jsonRequest(URL, 'POST', { customer: {} }), asyncParams({ orderId: 'o1' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('orden vencida ⇒ 409 status expirada', async () => {
    const order = { ...completeOrder(), expires_at: new Date(Date.now() - 1000).toISOString() };
    supabaseStub = makeSupabaseStub(tablesFor(order));
    const res = await POST(jsonRequest(URL, 'POST', { customer: { name: 'Ana' } }), asyncParams({ orderId: 'o1' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe('expirada');
    expect(orderUpdateCapture).not.toHaveBeenCalled();
  });

  it('orden ya pagada ⇒ 409 status ya_usada', async () => {
    const order = { ...completeOrder(), status: 'pagado' };
    supabaseStub = makeSupabaseStub(tablesFor(order));
    const res = await POST(jsonRequest(URL, 'POST', { customer: { name: 'Ana' } }), asyncParams({ orderId: 'o1' }));
    expect(res.status).toBe(409);
    expect((await res.json()).status).toBe('ya_usada');
  });

  it('OPTIONS responde 204', async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
  });
});

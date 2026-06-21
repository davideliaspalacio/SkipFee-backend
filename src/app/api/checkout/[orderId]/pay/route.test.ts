import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub, jsonRequest, asyncParams } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const customerUpsertCapture = vi.fn();
const orderUpdateCapture = vi.fn();

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => supabaseStub.client,
}));

// Multi-empresa: `wompiConfigFor(companyId)` reemplaza la lectura directa de
// process.env. Lo mockeamos derivando la config de las MISMAS env vars que ya
// usaban estos tests (WOMPI_MODE/PUBLIC_KEY/INTEGRITY_SECRET), así el resto del
// test no cambia.
vi.mock('@/lib/integrations', () => ({
  wompiConfigFor: vi.fn(async () => ({
    mode: (process.env.WOMPI_MODE ?? 'mock') === 'real' ? 'real' : 'mock',
    publicKey: process.env.WOMPI_PUBLIC_KEY ?? null,
    integritySecret: process.env.WOMPI_INTEGRITY_SECRET ?? null,
    eventsSecret: process.env.WOMPI_EVENTS_SECRET ?? null,
  })),
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
    company_id: 'co-1',
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
  // Default a `mock` en cada test salvo que se sobreescriba.
  process.env.WOMPI_MODE = 'mock';
  delete process.env.WOMPI_PUBLIC_KEY;
  delete process.env.WOMPI_INTEGRITY_SECRET;
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

  it('cerrado por horario ⇒ 409 status cerrado, no paga', async () => {
    const allClosed = Object.fromEntries(
      ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(d => [d, { closed: true }]),
    );
    supabaseStub = makeSupabaseStub({
      ...tablesFor(completeOrder()),
      settings: { single: { hours: allClosed, orders_paused: false } },
    });
    const res = await POST(
      jsonRequest(URL, 'POST', { customer: { name: 'Ana' } }),
      asyncParams({ orderId: 'o1' }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe('cerrado');
    expect(orderUpdateCapture).not.toHaveBeenCalled();
  });

  it('OPTIONS responde 204', async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
  });

  // ============================================================
  // WOMPI_MODE=real: devuelve widgetConfig en vez de paymentLink mock
  // ============================================================

  it('WOMPI_MODE=real ⇒ widgetConfig con signature válida + paymentLink:null', async () => {
    process.env.WOMPI_MODE = 'real';
    process.env.WOMPI_PUBLIC_KEY = 'pub_test_xxxxxxxxxxxxxxxxxx';
    process.env.WOMPI_INTEGRITY_SECRET = 'test_integrity_secret_demo';

    supabaseStub = makeSupabaseStub(tablesFor(completeOrder()));
    const res = await POST(
      jsonRequest(URL, 'POST', { customer: { name: 'Ana Pérez', email: 'ana@mail.com' } }),
      asyncParams({ orderId: 'o1' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.total).toBe(60500);
    expect(body.paymentLink).toBeNull();
    expect(body.widgetConfig).toBeTruthy();
    expect(body.widgetConfig.publicKey).toBe('pub_test_xxxxxxxxxxxxxxxxxx');
    expect(body.widgetConfig.currency).toBe('COP');
    expect(body.widgetConfig.amountInCents).toBe(6050000); // 60500 * 100
    expect(body.widgetConfig.reference).toBe('o1');
    expect(body.widgetConfig.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(body.widgetConfig.redirectUrl).toBe('http://localhost:5173/pedir/pago/resultado?orderId=o1');
    expect(body.widgetConfig.customerData?.email).toBe('ana@mail.com');
    expect(body.widgetConfig.customerData?.fullName).toBe('Ana Pérez');
  });

  it('WOMPI_MODE=real sin WOMPI_PUBLIC_KEY ⇒ 500 con error claro', async () => {
    process.env.WOMPI_MODE = 'real';
    delete process.env.WOMPI_PUBLIC_KEY;
    process.env.WOMPI_INTEGRITY_SECRET = 'x';
    supabaseStub = makeSupabaseStub(tablesFor(completeOrder()));
    const res = await POST(
      jsonRequest(URL, 'POST', { customer: { name: 'Ana' } }),
      asyncParams({ orderId: 'o1' }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/wompi_public_key/);
  });

  it('WOMPI_MODE=real sin WOMPI_INTEGRITY_SECRET ⇒ 500 con error claro', async () => {
    process.env.WOMPI_MODE = 'real';
    process.env.WOMPI_PUBLIC_KEY = 'pub_test_xxx';
    delete process.env.WOMPI_INTEGRITY_SECRET;
    supabaseStub = makeSupabaseStub(tablesFor(completeOrder()));
    const res = await POST(
      jsonRequest(URL, 'POST', { customer: { name: 'Ana' } }),
      asyncParams({ orderId: 'o1' }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/WOMPI_INTEGRITY_SECRET/);
  });

  it('WOMPI_MODE=mock (default) ⇒ paymentLink + widgetConfig:null', async () => {
    // Re-verifica el comportamiento legacy explícitamente: el frontend nuevo
    // puede chequear `widgetConfig` y caer a `paymentLink` si es null.
    supabaseStub = makeSupabaseStub(tablesFor(completeOrder()));
    const res = await POST(
      jsonRequest(URL, 'POST', { customer: { name: 'Ana' } }),
      asyncParams({ orderId: 'o1' }),
    );
    const body = await res.json();
    expect(body.paymentLink).toBe('http://localhost:3000/wompi/checkout/o1');
    expect(body.widgetConfig).toBeNull();
  });
});

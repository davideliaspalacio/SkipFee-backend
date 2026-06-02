import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeSupabaseStub, jsonRequest } from '@/lib/checkout/test-helpers';

const orderInsertCapture = vi.fn();
const customerUpsertCapture = vi.fn();
let supabaseStub: ReturnType<typeof makeSupabaseStub>;

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => supabaseStub.client,
}));

import { POST, OPTIONS } from './route';

function makeStub() {
  return makeSupabaseStub({
    orders: {
      onInsert: (payload) => {
        orderInsertCapture(payload);
        const p = payload as { id: string; expires_at: string };
        return { data: { id: p.id, expires_at: p.expires_at } };
      },
    },
    customers: {
      onUpsert: (payload) => {
        customerUpsertCapture(payload);
        return { data: { id: 'cust-uuid-1' } };
      },
      single: { id: 'cust-uuid-1' },
    },
    zones: {
      single: { id: 'poblado', lat: 6.2087, lng: -75.5658 },
    },
  });
}

describe('POST /api/checkout/sessions', () => {
  const ORIGINAL = process.env.STOREFRONT_ORIGIN;
  beforeEach(() => {
    process.env.STOREFRONT_ORIGIN = 'http://localhost:5173';
    process.env.CHECKOUT_TTL_MINUTES = '30';
    orderInsertCapture.mockReset();
    customerUpsertCapture.mockReset();
    supabaseStub = makeStub();
  });
  afterEach(() => {
    process.env.STOREFRONT_ORIGIN = ORIGINAL;
  });

  it('crea orden borrador y devuelve orderId, url y expiresAt (sin customer/delivery)', async () => {
    const before = Date.now();
    const res = await POST(jsonRequest('http://localhost:3000/api/checkout/sessions', 'POST', {
      phone: '573136913188',
    }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.orderId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(body.url).toBe(`http://localhost:5173/pedir?orderId=${body.orderId}&userId=573136913188`);
    const exp = new Date(body.expiresAt).getTime();
    expect(exp).toBeGreaterThanOrEqual(before + 29 * 60_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 31 * 60_000);

    const inserted = orderInsertCapture.mock.calls[0][0];
    expect(inserted.status).toBe('borrador');
    expect(inserted.phone).toBe('573136913188');
    expect(inserted.id).toBe(body.orderId);
    expect(inserted.expires_at).toBe(body.expiresAt);
    // Sin customer/delivery → no se setean
    expect(inserted.customer_id).toBeUndefined();
    expect(inserted.address).toBeUndefined();
    expect(inserted.zone_id).toBeUndefined();
    // Y NO se hizo upsert de customer
    expect(customerUpsertCapture).not.toHaveBeenCalled();
  });

  it('respeta ttlMinutes del body', async () => {
    const before = Date.now();
    const res = await POST(jsonRequest('http://localhost:3000/api/checkout/sessions', 'POST', {
      phone: '573136913188',
      ttlMinutes: 10,
    }));
    const body = await res.json();
    const exp = new Date(body.expiresAt).getTime();
    expect(exp).toBeGreaterThanOrEqual(before + 9 * 60_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 11 * 60_000);
  });

  it('con customer + delivery: upsert customer y persiste customer_id + address + zone_id + lat/lng', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/checkout/sessions', 'POST', {
      phone: '573136913188',
      customer: { name: 'Edison Bedoya', email: 'edison@gmail.com' },
      delivery: { address: 'Cra 43A #5-15', zoneId: 'poblado' },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Customer upsert con los datos del bot
    expect(customerUpsertCapture).toHaveBeenCalledTimes(1);
    const upsertedCustomer = customerUpsertCapture.mock.calls[0][0];
    expect(upsertedCustomer.name).toBe('Edison Bedoya');
    expect(upsertedCustomer.email).toBe('edison@gmail.com');
    expect(upsertedCustomer.phone).toBe('573136913188');
    expect(upsertedCustomer.addr).toBe('Cra 43A #5-15');
    expect(upsertedCustomer.zone_id).toBe('poblado');

    // Orden creada con customer_id + dir + zona + lat/lng (de la zona)
    const insertedOrder = orderInsertCapture.mock.calls[0][0];
    expect(insertedOrder.customer_id).toBe('cust-uuid-1');
    expect(insertedOrder.address).toBe('Cra 43A #5-15');
    expect(insertedOrder.zone_id).toBe('poblado');
    expect(insertedOrder.lat).toBe(6.2087);
    expect(insertedOrder.lng).toBe(-75.5658);
  });

  it('email opcional: cliente sin email igual hace upsert con email null', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/checkout/sessions', 'POST', {
      phone: '573136913188',
      customer: { name: 'Ana' },
      delivery: { address: 'Cra 1', zoneId: 'poblado' },
    }));
    expect(res.status).toBe(200);
    const up = customerUpsertCapture.mock.calls[0][0];
    expect(up.name).toBe('Ana');
    expect(up.email).toBeNull();
  });

  it('si delivery.zoneId no existe ⇒ 400', async () => {
    supabaseStub = makeSupabaseStub({
      zones: { single: null }, // zona no existe
      customers: { onUpsert: () => ({ data: { id: 'x' } }) },
      orders: { onInsert: () => ({ data: { id: 'x' } }) },
    });
    const res = await POST(jsonRequest('http://localhost:3000/api/checkout/sessions', 'POST', {
      phone: '573136913188',
      customer: { name: 'Ana' },
      delivery: { address: 'Cra 1', zoneId: 'no-existe' },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('no-existe');
    expect(orderInsertCapture).not.toHaveBeenCalled();
  });

  it('rechaza phone inválido con 400', async () => {
    const res = await POST(jsonRequest('http://localhost:3000/api/checkout/sessions', 'POST', {
      phone: 'abc',
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('OPTIONS responde preflight 204', async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });
});

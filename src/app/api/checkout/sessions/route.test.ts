import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeSupabaseStub, jsonRequest } from '@/lib/checkout/test-helpers';

const insertCapture = vi.fn();
let supabaseStub: ReturnType<typeof makeSupabaseStub>;

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => supabaseStub.client,
}));

import { POST, OPTIONS } from './route';

describe('POST /api/checkout/sessions', () => {
  const ORIGINAL = process.env.STOREFRONT_ORIGIN;
  beforeEach(() => {
    process.env.STOREFRONT_ORIGIN = 'http://localhost:5173';
    process.env.CHECKOUT_TTL_MINUTES = '30';
    insertCapture.mockReset();
    supabaseStub = makeSupabaseStub({
      orders: {
        onInsert: (payload) => {
          insertCapture(payload);
          const p = payload as { id: string };
          return { data: { id: p.id, expires_at: (payload as { expires_at: string }).expires_at } };
        },
      },
    });
  });
  afterEach(() => {
    process.env.STOREFRONT_ORIGIN = ORIGINAL;
  });

  it('crea orden borrador y devuelve orderId, url y expiresAt', async () => {
    const before = Date.now();
    const res = await POST(jsonRequest('http://localhost:3000/api/checkout/sessions', 'POST', {
      phone: '573136913188',
    }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ok).toBe(true);
    // orderId es un uuid
    expect(body.orderId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // url apunta al storefront con orderId + userId
    expect(body.url).toBe(`http://localhost:5173/pedir?orderId=${body.orderId}&userId=573136913188`);
    // expiresAt ~ now + 30 min
    const exp = new Date(body.expiresAt).getTime();
    expect(exp).toBeGreaterThanOrEqual(before + 29 * 60_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 31 * 60_000);

    // El insert llevó status borrador + phone + expires_at + id
    const inserted = insertCapture.mock.calls[0][0];
    expect(inserted.status).toBe('borrador');
    expect(inserted.phone).toBe('573136913188');
    expect(inserted.id).toBe(body.orderId);
    expect(inserted.expires_at).toBe(body.expiresAt);
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

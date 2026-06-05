import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeSupabaseStub } from '@/lib/checkout/test-helpers';
import { giftCartLine } from './gift';

const PHONE = '573136913188';
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

describe('giftCartLine', () => {
  it('devuelve la línea $0 con reward otorgado vigente + producto configurado', async () => {
    const stub = makeSupabaseStub({
      rewards: { rows: [{ id: 'rw1', phone: PHONE, status: 'otorgado', expires_at: FUTURE }] },
      settings: { single: { review_gift_product_id: 'gift1' } },
      products: { rows: [{ id: 'gift1', name: 'Postre de regalo' }] },
    });
    const line = await giftCartLine(stub.client as SupabaseClient, PHONE);
    expect(line).toEqual({
      productId: 'gift1',
      name: 'Postre de regalo',
      qty: 1,
      price: 0,
      lineTotal: 0,
      gift: true,
    });
  });

  it('null si el cliente no tiene reward otorgado vigente', async () => {
    const stub = makeSupabaseStub({
      rewards: { rows: [] },
      settings: { single: { review_gift_product_id: 'gift1' } },
      products: { rows: [{ id: 'gift1', name: 'Postre de regalo' }] },
    });
    expect(await giftCartLine(stub.client as SupabaseClient, PHONE)).toBeNull();
  });

  it('null si no hay producto de regalo configurado', async () => {
    const stub = makeSupabaseStub({
      rewards: { rows: [{ id: 'rw1', phone: PHONE, status: 'otorgado', expires_at: FUTURE }] },
      settings: { single: { review_gift_product_id: null } },
      products: { rows: [{ id: 'gift1', name: 'Postre de regalo' }] },
    });
    expect(await giftCartLine(stub.client as SupabaseClient, PHONE)).toBeNull();
  });

  it('null si el producto configurado ya no existe en el catálogo', async () => {
    const stub = makeSupabaseStub({
      rewards: { rows: [{ id: 'rw1', phone: PHONE, status: 'otorgado', expires_at: FUTURE }] },
      settings: { single: { review_gift_product_id: 'borrado' } },
      products: { rows: [] },
    });
    expect(await giftCartLine(stub.client as SupabaseClient, PHONE)).toBeNull();
  });
});

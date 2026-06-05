import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeSupabaseStub } from '@/lib/checkout/test-helpers';
import { redeemRewardForOrder } from './rewards';

describe('redeemRewardForOrder', () => {
  it('canjea el cupón otorgado vigente y deja constancia en la nota (sin pisar la del cliente)', async () => {
    const rewardUpdate = vi.fn();
    const orderUpdate = vi.fn();
    const stub = makeSupabaseStub({
      rewards: {
        rows: [{ id: 'rw1', phone: '573000', status: 'otorgado', redeemed_order_id: null }],
        onUpdate: (p) => { rewardUpdate(p); return {}; },
      },
      settings: { single: { review_gift_name: 'Brownie' } },
      orders: { single: { note: 'sin cebolla' }, onUpdate: (p) => { orderUpdate(p); return {}; } },
    });

    const res = await redeemRewardForOrder({
      sb: stub.client as SupabaseClient,
      orderId: 'o9',
      phone: '573000',
    });

    expect(res.redeemed).toBe(true);
    expect(rewardUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'canjeado', redeemed_order_id: 'o9' }),
    );
    const note = orderUpdate.mock.calls[0][0].note as string;
    expect(note).toContain('Brownie');
    expect(note).toContain('sin cebolla'); // append, no reemplazo
  });

  it('si hay producto de regalo configurado ⇒ inserta un order_item $0 para la cocina', async () => {
    const itemInsert = vi.fn();
    const stub = makeSupabaseStub({
      rewards: {
        rows: [{ id: 'rw1', phone: '573000', status: 'otorgado', redeemed_order_id: null }],
        onUpdate: () => ({}),
      },
      settings: { single: { review_gift_name: 'Brownie', review_gift_product_id: 'gift1' } },
      orders: { single: { note: null }, onUpdate: () => ({}) },
      order_items: { onInsert: (p) => { itemInsert(p); return {}; } },
    });
    const res = await redeemRewardForOrder({
      sb: stub.client as SupabaseClient,
      orderId: 'o9',
      phone: '573000',
    });
    expect(res.redeemed).toBe(true);
    expect(itemInsert).toHaveBeenCalledWith(
      expect.objectContaining({ order_id: 'o9', product_id: 'gift1', qty: 1, price_at_order: 0 }),
    );
  });

  it('idempotente: si el pedido ya tiene un cupón canjeado, no hace nada', async () => {
    const stub = makeSupabaseStub({
      rewards: { rows: [{ id: 'rwX', redeemed_order_id: 'o9' }] },
    });
    const res = await redeemRewardForOrder({
      sb: stub.client as SupabaseClient,
      orderId: 'o9',
      phone: '573000',
    });
    expect(res.redeemed).toBe(false);
  });

  it('sin cupón otorgado ⇒ no canjea', async () => {
    const stub = makeSupabaseStub({ rewards: { rows: [] } });
    const res = await redeemRewardForOrder({
      sb: stub.client as SupabaseClient,
      orderId: 'o9',
      phone: '573000',
    });
    expect(res.redeemed).toBe(false);
  });
});

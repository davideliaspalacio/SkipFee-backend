import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub, jsonRequest, asyncParams } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const updateCapture = vi.fn();
const notifyMock = vi.fn();
const redeemMock = vi.fn();

vi.mock('@/lib/db', () => ({ supabaseAdmin: () => supabaseStub.client }));
vi.mock('@/lib/orders/notify', () => ({ notifyOrderStatus: (...a: unknown[]) => notifyMock(...a) }));
vi.mock('@/lib/orders/rewards', () => ({ redeemRewardForOrder: (...a: unknown[]) => redeemMock(...a) }));

import { PATCH } from './route';

const URL = 'http://localhost:3000/api/orders/o1/status';

function stubWithOrder(order: unknown) {
  return makeSupabaseStub({
    orders: {
      single: order,
      onUpdate: (payload: unknown, filters: Record<string, unknown>) => {
        updateCapture(payload, filters);
        return {};
      },
    },
  });
}

beforeEach(() => {
  updateCapture.mockReset();
  notifyMock.mockReset().mockResolvedValue({ sent: true });
  redeemMock.mockReset().mockResolvedValue(undefined);
});

describe('PATCH /api/orders/:id/status', () => {
  it('al ENTRAR a entregado setea delivered_at (lo usan encuesta diferida + reescritura)', async () => {
    supabaseStub = stubWithOrder({ id: 'o1', status: 'ruta', phone: '573000', notified_statuses: [], customer: { name: 'Ana' } });
    const res = await PATCH(jsonRequest(URL, 'PATCH', { status: 'entregado' }), asyncParams({ id: 'o1' }));
    expect(res.status).toBe(200);
    const [payload] = updateCapture.mock.calls[0];
    expect(payload.status).toBe('entregado');
    expect(payload.delivered_at).toBeTruthy();
  });

  it('una transición que NO es a entregado no setea delivered_at', async () => {
    supabaseStub = stubWithOrder({ id: 'o1', status: 'pagado', phone: '573000', notified_statuses: [], customer: { name: 'Ana' } });
    const res = await PATCH(jsonRequest(URL, 'PATCH', { status: 'cocina' }), asyncParams({ id: 'o1' }));
    expect(res.status).toBe(200);
    const [payload] = updateCapture.mock.calls[0];
    expect(payload.delivered_at).toBeUndefined();
  });

  it('noop (mismo estado) no actualiza nada', async () => {
    supabaseStub = stubWithOrder({ id: 'o1', status: 'entregado', phone: '573000', notified_statuses: ['entregado'], customer: { name: 'Ana' } });
    const res = await PATCH(jsonRequest(URL, 'PATCH', { status: 'entregado' }), asyncParams({ id: 'o1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.noop).toBe(true);
    expect(updateCapture).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeSupabaseStub, jsonRequest } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const updateCapture = vi.fn();
const notifyMock = vi.fn();
const redeemMock = vi.fn();

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// `withTenant` se mockea para inyectar un `ctx` falso (db = stub, company fija)
// y exponer el handler interno con la firma (request, ctx, params). Así el test
// ejercita la lógica de negocio sin montar auth/RLS reales.
vi.mock('@/lib/tenant', () => ({
  withTenant: (handler: (req: NextRequest, ctx: unknown, params: unknown) => unknown) =>
    (req: NextRequest, params: { companyId: string; id: string }) =>
      handler(req, { db: supabaseStub.client, company: { id: COMPANY_ID, slug: 'bros-and-subs' } }, params),
}));
vi.mock('@/lib/orders/notify', () => ({ notifyOrderStatus: (...a: unknown[]) => notifyMock(...a) }));
vi.mock('@/lib/orders/rewards', () => ({ redeemRewardForOrder: (...a: unknown[]) => redeemMock(...a) }));

import { PATCH as PATCH_ROUTE } from './route';

// El mock de `withTenant` cambia la firma en runtime a (request, params) — donde
// params ya viene resuelto. El tipo estático de la ruta real no lo refleja, así
// que casteamos a la firma que el mock realmente expone para invocarla en tests.
const PATCH = PATCH_ROUTE as unknown as (
  req: NextRequest,
  params: { companyId: string; id: string },
) => Promise<Response>;

const URL = `http://localhost:3000/api/bros-and-subs/orders/o1/status`;

// El handler mockeado recibe los params resueltos (no la Promise de Next).
function params(p: { id: string }) {
  return { companyId: 'bros-and-subs', ...p };
}

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

describe('PATCH /api/:companyId/orders/:id/status', () => {
  it('al ENTRAR a entregado setea delivered_at (lo usan encuesta diferida + reescritura)', async () => {
    supabaseStub = stubWithOrder({ id: 'o1', status: 'ruta', phone: '573000', notified_statuses: [], customer: { name: 'Ana' } });
    const res = await PATCH(jsonRequest(URL, 'PATCH', { status: 'entregado' }), params({ id: 'o1' }));
    expect(res.status).toBe(200);
    const [payload] = updateCapture.mock.calls[0];
    expect(payload.status).toBe('entregado');
    expect(payload.delivered_at).toBeTruthy();
  });

  it('una transición que NO es a entregado no setea delivered_at', async () => {
    supabaseStub = stubWithOrder({ id: 'o1', status: 'pagado', phone: '573000', notified_statuses: [], customer: { name: 'Ana' } });
    const res = await PATCH(jsonRequest(URL, 'PATCH', { status: 'cocina' }), params({ id: 'o1' }));
    expect(res.status).toBe(200);
    const [payload] = updateCapture.mock.calls[0];
    expect(payload.delivered_at).toBeUndefined();
  });

  it('scopea la query por company_id (aislamiento multi-empresa)', async () => {
    supabaseStub = stubWithOrder({ id: 'o1', status: 'pagado', phone: '573000', notified_statuses: [], customer: { name: 'Ana' } });
    await PATCH(jsonRequest(URL, 'PATCH', { status: 'cocina' }), params({ id: 'o1' }));
    const [, filters] = updateCapture.mock.calls[0];
    expect(filters.company_id).toBe(COMPANY_ID);
  });

  it('al pagar canjea cupón pasándole companyId', async () => {
    supabaseStub = stubWithOrder({ id: 'o1', status: 'nuevo', phone: '573000', notified_statuses: [], customer: { name: 'Ana' } });
    await PATCH(jsonRequest(URL, 'PATCH', { status: 'pagado' }), params({ id: 'o1' }));
    expect(redeemMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID }));
  });

  it('noop (mismo estado) no actualiza nada', async () => {
    supabaseStub = stubWithOrder({ id: 'o1', status: 'entregado', phone: '573000', notified_statuses: ['entregado'], customer: { name: 'Ana' } });
    const res = await PATCH(jsonRequest(URL, 'PATCH', { status: 'entregado' }), params({ id: 'o1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.noop).toBe(true);
    expect(updateCapture).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const orderUpdateCapture = vi.fn();
const chatUpdateCapture = vi.fn();
const sendTextMock = vi.fn();
const recordMessageMock = vi.fn();

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => supabaseStub.client,
}));
vi.mock('@/lib/kapso/client', () => ({
  sendText: (...args: unknown[]) => sendTextMock(...args),
}));
vi.mock('@/lib/messaging', () => ({
  recordMessage: (...args: unknown[]) => recordMessageMock(...args),
}));

import { POST } from './route';

const URL = 'http://localhost:3000/api/wompi/webhook';

function jsonReq(body: unknown) {
  return new Request(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

function tablesFor(orderRow: unknown) {
  return {
    orders: {
      single: orderRow,
      onUpdate: (payload: unknown) => { orderUpdateCapture(payload); return {}; },
    },
    chats: {
      onUpdate: (payload: unknown) => { chatUpdateCapture(payload); return {}; },
    },
  };
}

function borrador(extra: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    status: 'borrador',
    phone: '573136913188',
    total: 60500,
    customer: { name: 'Ana Pérez' },
    ...extra,
  };
}

beforeEach(() => {
  orderUpdateCapture.mockReset();
  chatUpdateCapture.mockReset();
  sendTextMock.mockReset().mockResolvedValue({ messages: [{ id: 'wamid-1' }] });
  recordMessageMock.mockReset().mockResolvedValue({ chatId: 'wa:573136913188' });
});

describe('POST /api/wompi/webhook — borrador → pagado', () => {
  it('APPROVED sobre una orden borrador la pasa a pagado + side effects', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(borrador()));
    const res = await POST(jsonReq({ orderId: 'o1', status: 'APPROVED' }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.applied).toBe(true);
    expect(body.newStatus).toBe('pagado');

    // status pasó a pagado
    expect(orderUpdateCapture).toHaveBeenCalled();
    expect(orderUpdateCapture.mock.calls[0][0]).toEqual({ status: 'pagado' });
    // side effects: WhatsApp "pago recibido" + cerrar flow_state
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('pago recibido'));
    expect(chatUpdateCapture).toHaveBeenCalled();
    expect(chatUpdateCapture.mock.calls[0][0].flow_state.step).toBe('finalizado');
  });

  it('mantiene compatibilidad: APPROVED sobre orden "nuevo" sigue funcionando', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(borrador({ status: 'nuevo' })));
    const res = await POST(jsonReq({ orderId: 'o1', status: 'APPROVED' }));
    const body = await res.json();
    expect(body.applied).toBe(true);
    expect(orderUpdateCapture.mock.calls[0][0]).toEqual({ status: 'pagado' });
  });

  it('orden ya pagada ⇒ applied:false, no re-actualiza ni re-notifica', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(borrador({ status: 'pagado' })));
    const res = await POST(jsonReq({ orderId: 'o1', status: 'APPROVED' }));
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(orderUpdateCapture).not.toHaveBeenCalled();
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('revalida monto: si amount != total ⇒ NO aprueba (applied:false)', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(borrador({ total: 60500 })));
    const res = await POST(jsonReq({ orderId: 'o1', status: 'APPROVED', amount: 50000 }));
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.reason).toMatch(/monto|amount/i);
    expect(orderUpdateCapture).not.toHaveBeenCalled();
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('revalida monto: si amount == total ⇒ aprueba', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(borrador({ total: 60500 })));
    const res = await POST(jsonReq({ orderId: 'o1', status: 'APPROVED', amount: 60500 }));
    const body = await res.json();
    expect(body.applied).toBe(true);
    expect(orderUpdateCapture.mock.calls[0][0]).toEqual({ status: 'pagado' });
  });

  it('mock sin amount: no revalida (aprueba) — el form de Wompi mock no manda monto', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(borrador()));
    const res = await POST(jsonReq({ orderId: 'o1', status: 'APPROVED' }));
    expect((await res.json()).applied).toBe(true);
  });

  it('status no aprobado (DECLINED) ⇒ applied:false sin tocar la orden', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(borrador()));
    const res = await POST(jsonReq({ orderId: 'o1', status: 'DECLINED' }));
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(orderUpdateCapture).not.toHaveBeenCalled();
  });
});

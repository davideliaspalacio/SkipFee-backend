import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub } from '@/lib/checkout/test-helpers';
import { notifyOrderStatus, NOTIFIABLE_STATUSES } from './notify';

const sendTextMock = vi.fn();
const recordMessageMock = vi.fn();

vi.mock('@/lib/kapso/client', () => ({
  sendText: (...args: unknown[]) => sendTextMock(...args),
}));
vi.mock('@/lib/messaging', () => ({
  recordMessage: (...args: unknown[]) => recordMessageMock(...args),
}));

const updateCapture = vi.fn();

function stub() {
  return makeSupabaseStub({
    orders: { onUpdate: (payload: unknown) => { updateCapture(payload); return {}; } },
  });
}

function order(extra: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    phone: '573136913188',
    notified_statuses: [] as string[],
    customer: { name: 'Ana Pérez' },
    ...extra,
  };
}

beforeEach(() => {
  sendTextMock.mockReset().mockResolvedValue({ messages: [{ id: 'wamid-1' }] });
  recordMessageMock.mockReset().mockResolvedValue({ chatId: 'wa:573136913188' });
  updateCapture.mockReset();
});

describe('notifyOrderStatus', () => {
  it('envía y marca cuando el estado es notificable y no fue notificado', async () => {
    const sb = stub();
    const res = await notifyOrderStatus({ sb: sb.client as never, order: order(), newStatus: 'ruta' });
    expect(res.sent).toBe(true);
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('camino'));
    // usa el primer nombre del cliente
    expect(sendTextMock.mock.calls[0][1]).toContain('Ana');
    // marca el estado como notificado (append idempotente)
    expect(updateCapture).toHaveBeenCalledWith({ notified_statuses: ['ruta'] });
  });

  it('es idempotente: si ya se notificó ese estado, no reenvía', async () => {
    const sb = stub();
    const res = await notifyOrderStatus({
      sb: sb.client as never,
      order: order({ notified_statuses: ['ruta'] }),
      newStatus: 'ruta',
    });
    expect(res).toEqual({ sent: false, skipped: 'already-notified' });
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(updateCapture).not.toHaveBeenCalled();
  });

  it('preserva estados previos al marcar uno nuevo', async () => {
    const sb = stub();
    await notifyOrderStatus({
      sb: sb.client as never,
      order: order({ notified_statuses: ['pagado', 'cocina'] }),
      newStatus: 'ruta',
    });
    expect(updateCapture).toHaveBeenCalledWith({ notified_statuses: ['pagado', 'cocina', 'ruta'] });
  });

  it('estado no notificable (empacado) ⇒ no envía', async () => {
    const sb = stub();
    const res = await notifyOrderStatus({ sb: sb.client as never, order: order(), newStatus: 'empacado' });
    expect(res).toEqual({ sent: false, skipped: 'not-notifiable' });
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('cubre los 4 estados notificables con mensajes propios', async () => {
    for (const status of NOTIFIABLE_STATUSES) {
      sendTextMock.mockClear();
      const sb = stub();
      const res = await notifyOrderStatus({ sb: sb.client as never, order: order(), newStatus: status });
      expect(res.sent).toBe(true);
      expect(sendTextMock).toHaveBeenCalledTimes(1);
      expect((sendTextMock.mock.calls[0][1] as string).length).toBeGreaterThan(0);
    }
  });

  it('si el envío falla ⇒ sent:false con error, no marca como notificado', async () => {
    sendTextMock.mockRejectedValueOnce(new Error('kapso down'));
    const sb = stub();
    const res = await notifyOrderStatus({ sb: sb.client as never, order: order(), newStatus: 'ruta' });
    expect(res.sent).toBe(false);
    expect(res.error).toContain('kapso down');
    expect(updateCapture).not.toHaveBeenCalled();
  });

  it('sin nombre de cliente igual envía (saludo genérico)', async () => {
    const sb = stub();
    const res = await notifyOrderStatus({
      sb: sb.client as never,
      order: order({ customer: null }),
      newStatus: 'entregado',
    });
    expect(res.sent).toBe(true);
    expect(sendTextMock).toHaveBeenCalled();
  });
});

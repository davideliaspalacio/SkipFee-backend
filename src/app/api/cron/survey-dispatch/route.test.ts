import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeSupabaseStub } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const sendDeliverySurveyMock = vi.fn();

vi.mock('@/lib/db', () => ({ supabaseAdmin: () => supabaseStub.client }));
vi.mock('@/lib/orders/survey', () => ({
  sendDeliverySurvey: (...a: unknown[]) => sendDeliverySurveyMock(...a),
}));

import { POST } from './route';

const URL = 'http://localhost:3000/api/cron/survey-dispatch';

function req(secret?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== undefined) headers['x-cron-secret'] = secret;
  return new Request(URL, { method: 'POST', headers, body: '{}' }) as never;
}

const ORIGINAL = process.env.CRON_SECRET;
beforeEach(() => {
  process.env.CRON_SECRET = 'secret-123';
  sendDeliverySurveyMock.mockReset().mockResolvedValue({ sent: true });
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe('POST /api/cron/survey-dispatch', () => {
  it('sin CRON_SECRET configurado ⇒ 503', async () => {
    delete process.env.CRON_SECRET;
    supabaseStub = makeSupabaseStub({});
    const res = await POST(req('whatever'));
    expect(res.status).toBe(503);
  });

  it('secret incorrecto ⇒ 401 y no despacha nada', async () => {
    supabaseStub = makeSupabaseStub({});
    const res = await POST(req('mal'));
    expect(res.status).toBe(401);
    expect(sendDeliverySurveyMock).not.toHaveBeenCalled();
  });

  it('encuesta apagada en settings ⇒ no consulta pedidos', async () => {
    supabaseStub = makeSupabaseStub({ settings: { single: { survey_enabled: false } } });
    const res = await POST(req('secret-123'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disabled).toBe(true);
    expect(sendDeliverySurveyMock).not.toHaveBeenCalled();
  });

  it('despacha la encuesta solo para entregados SIN encuesta previa', async () => {
    supabaseStub = makeSupabaseStub({
      settings: { single: { survey_enabled: true, survey_delay_minutes: 30 } },
      orders: {
        rows: [
          { id: 'o1', phone: '573001', status: 'entregado', delivered_at: '2026-06-09T12:00:00Z' },
          { id: 'o2', phone: '573002', status: 'entregado', delivered_at: '2026-06-09T12:00:00Z' },
        ],
      },
      // o1 ya tiene la encuesta enviada → se descarta; o2 no.
      order_surveys: { rows: [{ order_id: 'o1', sent_at: '2026-06-09T12:31:00Z' }] },
    });
    const res = await POST(req('secret-123'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates).toBe(2);
    expect(body.sent).toBe(1);
    expect(sendDeliverySurveyMock).toHaveBeenCalledTimes(1);
    expect(sendDeliverySurveyMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'o2', phone: '573002' }),
    );
  });

  it('cuenta como skipped cuando sendDeliverySurvey no envía (humano / mid-order)', async () => {
    sendDeliverySurveyMock.mockResolvedValue({ sent: false, skipped: 'human' });
    supabaseStub = makeSupabaseStub({
      settings: { single: { survey_enabled: true, survey_delay_minutes: 30 } },
      orders: { rows: [{ id: 'o1', phone: '573001', status: 'entregado', delivered_at: '2026-06-09T12:00:00Z' }] },
      order_surveys: { rows: [] },
    });
    const res = await POST(req('secret-123'));
    const body = await res.json();
    expect(body.sent).toBe(0);
    expect(body.skipped).toBe(1);
  });
});

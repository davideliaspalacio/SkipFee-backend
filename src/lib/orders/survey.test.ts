import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeSupabaseStub } from '@/lib/checkout/test-helpers';

const sendSurveyMock = vi.fn();
const saveFlowStateMock = vi.fn();
vi.mock('@/lib/bot/flow/handlers', () => ({ sendSurvey: (...a: unknown[]) => sendSurveyMock(...a) }));
vi.mock('@/lib/bot/flow/persistence', () => ({ saveFlowState: (...a: unknown[]) => saveFlowStateMock(...a) }));

import { sendDeliverySurvey } from './survey';

beforeEach(() => {
  sendSurveyMock.mockReset().mockResolvedValue(undefined);
  saveFlowStateMock.mockReset().mockResolvedValue(undefined);
});

describe('sendDeliverySurvey', () => {
  it('envía la encuesta, la registra y deja el chat esperando la calificación', async () => {
    const surveyUpsert = vi.fn();
    const stub = makeSupabaseStub({
      settings: { single: { survey_enabled: true } },
      chats: { single: { status: 'bot' } },
      order_surveys: { onUpsert: p => { surveyUpsert(p); return {}; } },
    });
    await sendDeliverySurvey({ sb: stub.client as SupabaseClient, orderId: 'o1', phone: '573000' });
    expect(sendSurveyMock).toHaveBeenCalledWith({ phone: '573000', orderId: 'o1' });
    expect(surveyUpsert).toHaveBeenCalledWith(expect.objectContaining({ order_id: 'o1', phone: '573000' }));
    expect(surveyUpsert.mock.calls[0][0].sent_at).toBeTruthy();
    expect(saveFlowStateMock).toHaveBeenCalledWith(
      'wa:573000',
      expect.objectContaining({ step: 'postventa_encuesta', surveyOrderId: 'o1' }),
    );
  });

  it('no envía si la encuesta está desactivada en settings', async () => {
    const stub = makeSupabaseStub({ settings: { single: { survey_enabled: false } } });
    await sendDeliverySurvey({ sb: stub.client as SupabaseClient, orderId: 'o1', phone: '573000' });
    expect(sendSurveyMock).not.toHaveBeenCalled();
  });

  it('no envía si el chat lo está atendiendo un humano', async () => {
    const stub = makeSupabaseStub({
      settings: { single: { survey_enabled: true } },
      chats: { single: { status: 'human' } },
    });
    await sendDeliverySurvey({ sb: stub.client as SupabaseClient, orderId: 'o1', phone: '573000' });
    expect(sendSurveyMock).not.toHaveBeenCalled();
  });

  it('no re-encuesta si el cliente ya recibió una encuesta hace poco (survey_min_days)', async () => {
    const stub = makeSupabaseStub({
      settings: { single: { survey_enabled: true, survey_min_days: 30 } },
      chats: { single: { status: 'bot' } },
      order_surveys: { rows: [{ id: 'prev', phone: '573000', sent_at: new Date().toISOString() }] },
    });
    await sendDeliverySurvey({ sb: stub.client as SupabaseClient, orderId: 'o1', phone: '573000' });
    expect(sendSurveyMock).not.toHaveBeenCalled();
  });
});

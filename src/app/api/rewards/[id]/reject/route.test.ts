import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const sendTextMock = vi.fn();
const recordMessageMock = vi.fn();
const getMessageMock = vi.fn();

vi.mock('@/lib/db', () => ({ supabaseAdmin: () => supabaseStub.client }));
vi.mock('@/lib/kapso/client', () => ({ sendText: (...a: unknown[]) => sendTextMock(...a) }));
vi.mock('@/lib/messaging', () => ({ recordMessage: (...a: unknown[]) => recordMessageMock(...a) }));
vi.mock('@/lib/bot/messages/catalog', () => ({ getMessage: (...a: unknown[]) => getMessageMock(...a) }));
vi.mock('@/lib/bot/messages/render', () => ({ render: (tpl: string) => tpl }));

import { POST } from './route';

const PHONE = '573136913188';
const req = (id: string, body: unknown = {}) =>
  new Request(`http://localhost:3000/api/rewards/${id}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  sendTextMock.mockReset();
  recordMessageMock.mockReset();
  getMessageMock.mockReset();
  sendTextMock.mockResolvedValue({ messages: [{ id: 'wamid.1' }] });
  recordMessageMock.mockResolvedValue({});
  getMessageMock.mockResolvedValue({ body: 'No pudimos validar tu reseña.' });
});

describe('POST /api/rewards/:id/reject', () => {
  it('rechaza el cupón y devuelve el chat a modo bot', async () => {
    supabaseStub = makeSupabaseStub({
      rewards: { single: { id: 'rw1', phone: PHONE, status: 'pendiente' } },
      chats: {},
    });
    const res = await POST(req('rw1', { notes: 'no se ve la reseña' }), params('rw1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reward.status).toBe('rechazado');

    // FIX: aunque se rechace, el chat vuelve a 'bot' (caso cerrado).
    const chatUpd = supabaseStub.calls.find(c => c.table === 'chats' && c.op === 'update');
    expect(chatUpd?.payload).toEqual({ status: 'bot' });
    expect(chatUpd?.filters).toEqual({ id: `wa:${PHONE}` });
  });

  it('notify:false ⇒ no envía WhatsApp pero igual devuelve el chat al bot', async () => {
    supabaseStub = makeSupabaseStub({
      rewards: { single: { id: 'rw1', phone: PHONE, status: 'pendiente' } },
      chats: {},
    });
    const res = await POST(req('rw1', { notify: false }), params('rw1'));
    expect(res.status).toBe(200);
    expect(sendTextMock).not.toHaveBeenCalled();
    const chatUpd = supabaseStub.calls.find(c => c.table === 'chats' && c.op === 'update');
    expect(chatUpd?.payload).toEqual({ status: 'bot' });
  });

  it('si el cupón no está pendiente ⇒ 409 y NO toca el chat', async () => {
    supabaseStub = makeSupabaseStub({
      rewards: { single: { id: 'rw1', phone: PHONE, status: 'rechazado' } },
      chats: {},
    });
    const res = await POST(req('rw1'), params('rw1'));
    expect(res.status).toBe(409);
    expect(supabaseStub.calls.some(c => c.table === 'chats')).toBe(false);
  });
});

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
  new Request(`http://localhost:3000/api/rewards/${id}/approve`, {
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
  getMessageMock.mockResolvedValue({ body: '¡Listo! Tu {{postre}} te espera.' });
});

describe('POST /api/rewards/:id/approve', () => {
  it('otorga el cupón y devuelve el chat a modo bot (fix: no queda colgado en humano)', async () => {
    supabaseStub = makeSupabaseStub({
      rewards: { single: { id: 'rw1', phone: PHONE, status: 'pendiente' } },
      settings: { single: { review_gift_name: 'Brownie', review_gift_expiry_days: 30 } },
      chats: {},
    });

    const res = await POST(req('rw1', { grantedBy: 'op@bros.com' }), params('rw1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reward.status).toBe('otorgado');

    // El cupón se marcó 'otorgado'.
    const rewardUpd = supabaseStub.calls.find(c => c.table === 'rewards' && c.op === 'update');
    expect((rewardUpd?.payload as { status?: string } | undefined)?.status).toBe('otorgado');

    // FIX: el chat vuelve a 'bot' (id = wa:<phone>) para que el cliente siga interactuando.
    const chatUpd = supabaseStub.calls.find(c => c.table === 'chats' && c.op === 'update');
    expect(chatUpd).toBeDefined();
    expect(chatUpd?.payload).toEqual({ status: 'bot' });
    expect(chatUpd?.filters).toEqual({ id: `wa:${PHONE}` });
  });

  it('si el cupón no está pendiente ⇒ 409 y NO toca el chat', async () => {
    supabaseStub = makeSupabaseStub({
      rewards: { single: { id: 'rw1', phone: PHONE, status: 'otorgado' } },
      chats: {},
    });
    const res = await POST(req('rw1'), params('rw1'));
    expect(res.status).toBe(409);
    expect(supabaseStub.calls.some(c => c.table === 'chats')).toBe(false);
  });

  it('cupón inexistente ⇒ 404', async () => {
    supabaseStub = makeSupabaseStub({ rewards: { single: null }, chats: {} });
    const res = await POST(req('nope'), params('nope'));
    expect(res.status).toBe(404);
    expect(supabaseStub.calls.some(c => c.table === 'chats')).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeSupabaseStub, getRequest } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';

vi.mock('@/lib/tenant', () => ({
  withTenant: (handler: (req: NextRequest, ctx: unknown, params: unknown) => unknown) =>
    (req: NextRequest, params: { companyId: string; id: string }) =>
      handler(
        req,
        { db: supabaseStub.client, company: { id: COMPANY_ID, slug: 'bros-and-subs' } },
        params,
      ),
}));

import { POST as POST_ROUTE } from './route';

const POST = POST_ROUTE as unknown as (
  req: NextRequest,
  params: { companyId: string; id: string },
) => Promise<Response>;

describe('POST /api/:companyId/chats/:id/read', () => {
  beforeEach(() => {
    supabaseStub = makeSupabaseStub({
      chats: {
        rows: [{ id: 'wa:573001112233', company_id: COMPANY_ID, unread: 2 }],
        onUpdate: (payload) => ({
          data: { id: 'wa:573001112233', ...(payload as Record<string, unknown>) },
        }),
      },
      messages: {
        rows: [
          {
            company_id: COMPANY_ID,
            chat_id: 'wa:573001112233',
            direction: 'in',
            read_at: null,
          },
          {
            company_id: COMPANY_ID,
            chat_id: 'wa:573001112233',
            direction: 'out',
            read_at: null,
          },
        ],
      },
    });
  });

  it('marca mensajes entrantes y resetea unread del chat', async () => {
    const res = await POST(getRequest('http://x/api/1001/chats/wa:573001112233/read'), {
      companyId: '1001',
      id: 'wa:573001112233',
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      chatId: 'wa:573001112233',
      unread: 0,
    });

    const messagesUpdate = supabaseStub.calls.find(
      c => c.table === 'messages' && c.op === 'update',
    );
    expect(messagesUpdate?.payload).toHaveProperty('read_at');
    expect(messagesUpdate?.filters).toMatchObject({
      company_id: COMPANY_ID,
      chat_id: 'wa:573001112233',
      direction: 'in',
      read_at__is: null,
    });

    const chatUpdate = supabaseStub.calls.find(c => c.table === 'chats' && c.op === 'update');
    expect(chatUpdate?.payload).toEqual({ unread: 0 });
    expect(chatUpdate?.filters).toMatchObject({
      company_id: COMPANY_ID,
      id: 'wa:573001112233',
    });
  });

  it('devuelve 404 cuando el chat no existe en la empresa', async () => {
    supabaseStub = makeSupabaseStub({ chats: { rows: [] }, messages: {} });

    const res = await POST(getRequest('http://x/api/1001/chats/wa:nope/read'), {
      companyId: '1001',
      id: 'wa:nope',
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ ok: false, error: 'Chat no encontrado' });
  });
});

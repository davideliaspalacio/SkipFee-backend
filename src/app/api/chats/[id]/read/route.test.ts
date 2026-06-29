import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asyncParams, makeSupabaseStub } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => supabaseStub.client,
}));

import { POST } from './route';

describe('POST /api/chats/:id/read', () => {
  beforeEach(() => {
    supabaseStub = makeSupabaseStub({
      chats: {
        rows: [{ id: 'wa:573001112233', unread: 2 }],
        onUpdate: (payload) => ({
          data: { id: 'wa:573001112233', ...(payload as Record<string, unknown>) },
        }),
      },
      messages: {
        rows: [
          { chat_id: 'wa:573001112233', direction: 'in', read_at: null },
          { chat_id: 'wa:573001112233', direction: 'out', read_at: null },
        ],
      },
    });
  });

  it('marca mensajes entrantes y resetea unread del chat', async () => {
    const res = await POST(new Request('http://x') as never, asyncParams({ id: 'wa:573001112233' }));

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
      chat_id: 'wa:573001112233',
      direction: 'in',
      read_at__is: null,
    });

    const chatUpdate = supabaseStub.calls.find(c => c.table === 'chats' && c.op === 'update');
    expect(chatUpdate?.payload).toEqual({ unread: 0 });
  });

  it('devuelve 404 cuando el chat no existe', async () => {
    supabaseStub = makeSupabaseStub({ chats: { rows: [] }, messages: {} });

    const res = await POST(new Request('http://x') as never, asyncParams({ id: 'wa:nope' }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ ok: false, error: 'Chat no encontrado' });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => supabaseStub.client,
}));

import { GET } from './route';

describe('GET /api/chats/stats', () => {
  beforeEach(() => {
    supabaseStub = makeSupabaseStub({
      chats: {
        rows: [
          { status: 'bot' },
          { status: 'bot' },
          { status: 'human' },
          { status: 'pending' },
          { status: 'pending' },
          { status: 'pending' },
        ],
      },
    });
  });

  it('cuenta total y pendientes', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, total: 6, pending: 3 });
  });

  it('devuelve 0/0 si no hay chats', async () => {
    supabaseStub = makeSupabaseStub({ chats: { rows: [] } });
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ ok: true, total: 0, pending: 0 });
  });

  it('propaga error del supabase', async () => {
    supabaseStub = makeSupabaseStub({
      chats: { rows: [], error: { message: 'db down' } },
    });
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'db down' });
  });
});

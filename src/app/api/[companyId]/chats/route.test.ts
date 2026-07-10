import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeSupabaseStub, getRequest } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';

vi.mock('@/lib/tenant', () => ({
  withTenant: (handler: (req: NextRequest, ctx: unknown, params: unknown) => unknown) =>
    (req: NextRequest, params: { companyId: string }) =>
      handler(req, { db: supabaseStub.client, company: { id: COMPANY_ID } }, params),
}));

vi.mock('@/lib/chat-stats', () => ({
  chatStatsByPhone: vi.fn(async () => new Map()),
}));

import { GET as GET_ROUTE } from './route';

const GET = GET_ROUTE as unknown as (
  req: NextRequest,
  params: { companyId: string },
) => Promise<Response>;

describe('GET /api/:companyId/chats', () => {
  beforeEach(() => {
    supabaseStub = makeSupabaseStub({
      chats: {
        rows: [
          {
            id: 'wa:0001:573001112233',
            company_id: COMPANY_ID,
            name: 'Ana',
            phone: '573001112233',
            last: 'Hola',
            time: '12:00',
            unread: 2,
            status: 'human',
            zone_id: null,
            last_message_at: '2026-07-02T12:00:00Z',
          },
          {
            id: 'wa:0001:573009998888',
            company_id: COMPANY_ID,
            name: 'Luis',
            phone: '573009998888',
            last: 'Gracias',
            time: '12:05',
            unread: 0,
            status: 'bot',
            zone_id: null,
            last_message_at: '2026-07-02T12:05:00Z',
          },
        ],
      },
    });
  });

  it('resuelve un chat puntual por teléfono sin depender de la lista completa', async () => {
    const res = await GET(getRequest('http://x/api/1001/chats?phone=%2B57%20300%20111%202233'), {
      companyId: '1001',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.chats).toHaveLength(1);
    expect(body.chats[0]).toMatchObject({
      id: 'wa:0001:573001112233',
      phone: '573001112233',
      unread: 2,
    });
  });
});

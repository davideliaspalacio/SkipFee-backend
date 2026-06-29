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

import { GET as GET_ROUTE } from './route';

const GET = GET_ROUTE as unknown as (
  req: NextRequest,
  params: { companyId: string },
) => Promise<Response>;

describe('GET /api/:companyId/chats/stats', () => {
  beforeEach(() => {
    supabaseStub = makeSupabaseStub({
      chats: {
        rows: [
          { company_id: COMPANY_ID, status: 'bot', unread: 0 },
          { company_id: COMPANY_ID, status: 'bot', unread: 1 },
          { company_id: COMPANY_ID, status: 'human', unread: 2 },
          { company_id: COMPANY_ID, status: 'pending', unread: 0 },
          { company_id: COMPANY_ID, status: 'pending', unread: 3 },
          { company_id: COMPANY_ID, status: 'pending', unread: 0 },
          { company_id: 'otra', status: 'pending', unread: 9 },
        ],
      },
    });
  });

  it('cuenta total, pendientes y chats no leídos de la empresa', async () => {
    const res = await GET(getRequest('http://x/api/1001/chats/stats'), { companyId: '1001' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, total: 6, pending: 3, unread: 3 });
  });

  it('devuelve 0/0 si no hay chats', async () => {
    supabaseStub = makeSupabaseStub({ chats: { rows: [] } });
    const res = await GET(getRequest('http://x/api/1001/chats/stats'), { companyId: '1001' });
    const body = await res.json();
    expect(body).toEqual({ ok: true, total: 0, pending: 0, unread: 0 });
  });

  it('propaga error del supabase', async () => {
    supabaseStub = makeSupabaseStub({
      chats: { rows: [], error: { message: 'db down' } },
    });
    const res = await GET(getRequest('http://x/api/1001/chats/stats'), { companyId: '1001' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'db down' });
  });
});

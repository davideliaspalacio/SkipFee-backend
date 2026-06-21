import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeSupabaseStub, jsonRequest } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const updateCapture = vi.fn();
const updateFilters = vi.fn();

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// `withTenant` se mockea para inyectar un `ctx` falso (db = stub, company fija)
// y exponer el handler interno con la firma (request, ctx, params).
vi.mock('@/lib/tenant', () => ({
  withTenant: (handler: (req: NextRequest, ctx: unknown, params: unknown) => unknown) =>
    (req: NextRequest, params: { companyId: string; id: string }) =>
      handler(req, { db: supabaseStub.client, company: { id: COMPANY_ID, slug: 'bros-and-subs' } }, params),
}));

import { PATCH as PATCH_ROUTE, DELETE as DELETE_ROUTE } from './route';

const PATCH = PATCH_ROUTE as unknown as (
  req: NextRequest,
  params: { companyId: string; id: string },
) => Promise<Response>;
const DELETE = DELETE_ROUTE as unknown as (
  req: NextRequest,
  params: { companyId: string; id: string },
) => Promise<Response>;

function params(id: string) {
  return { companyId: 'bros-and-subs', id };
}

beforeEach(() => {
  updateCapture.mockReset();
  updateFilters.mockReset();
});

describe('PATCH /api/:companyId/zones/:id', () => {
  it('edita name + tarifa (name editable) y scopea por company_id', async () => {
    supabaseStub = makeSupabaseStub({
      zones: {
        onUpdate: (p: unknown, filters: Record<string, unknown>) => {
          updateCapture(p);
          updateFilters(filters);
          return { data: { id: 'poblado', name: 'Poblado Nuevo', tarifa: 7000, archived: false } };
        },
      },
    });
    const res = await PATCH(
      jsonRequest('http://x/api/bros-and-subs/zones/poblado', 'PATCH', { name: 'Poblado Nuevo', tarifa: 7000 }),
      params('poblado'),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(updateCapture.mock.calls[0][0]).toEqual({ name: 'Poblado Nuevo', tarifa: 7000 });
    expect(updateFilters.mock.calls[0][0].company_id).toBe(COMPANY_ID);
  });

  it('desarchiva con archived:false', async () => {
    supabaseStub = makeSupabaseStub({
      zones: { onUpdate: (p: unknown) => { updateCapture(p); return { data: { id: 'poblado', archived: false } }; } },
    });
    const res = await PATCH(
      jsonRequest('http://x/api/bros-and-subs/zones/poblado', 'PATCH', { archived: false }),
      params('poblado'),
    );
    expect(res.status).toBe(200);
    expect(updateCapture.mock.calls[0][0]).toEqual({ archived: false });
  });

  it('400 sin campos', async () => {
    supabaseStub = makeSupabaseStub({ zones: {} });
    const res = await PATCH(jsonRequest('http://x/api/bros-and-subs/zones/poblado', 'PATCH', {}), params('poblado'));
    expect(res.status).toBe(400);
  });

  it('404 si la zona no existe', async () => {
    supabaseStub = makeSupabaseStub({ zones: { onUpdate: () => ({}), single: null } });
    const res = await PATCH(jsonRequest('http://x/api/bros-and-subs/zones/nope', 'PATCH', { tarifa: 1 }), params('nope'));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/:companyId/zones/:id (archivar)', () => {
  it('archiva la zona (update archived=true) scopeado por company_id', async () => {
    supabaseStub = makeSupabaseStub({
      zones: {
        onUpdate: (p: unknown, filters: Record<string, unknown>) => {
          updateCapture(p);
          updateFilters(filters);
          return { data: { id: 'poblado' } };
        },
      },
    });
    const res = await DELETE(jsonRequest('http://x/api/bros-and-subs/zones/poblado', 'DELETE', {}), params('poblado'));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(updateCapture.mock.calls[0][0]).toEqual({ archived: true });
    expect(updateFilters.mock.calls[0][0].company_id).toBe(COMPANY_ID);
  });

  it('404 si la zona no existe', async () => {
    supabaseStub = makeSupabaseStub({ zones: { onUpdate: () => ({}), single: null } });
    const res = await DELETE(jsonRequest('http://x/api/bros-and-subs/zones/nope', 'DELETE', {}), params('nope'));
    expect(res.status).toBe(404);
  });
});

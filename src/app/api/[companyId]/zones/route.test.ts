import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeSupabaseStub, jsonRequest, getRequest } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const insertCapture = vi.fn();

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// `withTenant` se mockea para inyectar un `ctx` falso (db = stub, company fija)
// y exponer el handler interno con la firma (request, ctx, params).
vi.mock('@/lib/tenant', () => ({
  withTenant: (handler: (req: NextRequest, ctx: unknown, params: unknown) => unknown) =>
    (req: NextRequest, params: { companyId: string }) =>
      handler(req, { db: supabaseStub.client, company: { id: COMPANY_ID, slug: 'bros-and-subs' } }, params),
}));

import { GET as GET_ROUTE, POST as POST_ROUTE } from './route';

const GET = GET_ROUTE as unknown as (req: NextRequest, params: { companyId: string }) => Promise<Response>;
const POST = POST_ROUTE as unknown as (req: NextRequest, params: { companyId: string }) => Promise<Response>;

const params = { companyId: 'bros-and-subs' };

interface ZoneRow { id: string; archived?: boolean }

beforeEach(() => {
  insertCapture.mockReset();
});

describe('GET /api/:companyId/zones', () => {
  it('excluye archivadas por defecto', async () => {
    supabaseStub = makeSupabaseStub({
      zones: {
        rows: [
          { id: 'poblado', name: 'El Poblado', tarifa: 4500, archived: false, company_id: COMPANY_ID },
          { id: 'vieja', name: 'Vieja', tarifa: 5000, archived: true, company_id: COMPANY_ID },
        ],
      },
    });
    const res = await GET(getRequest('http://x/api/bros-and-subs/zones'), params);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect((body.zones as ZoneRow[]).map(z => z.id)).toEqual(['poblado']);
  });

  it('?all=1 incluye archivadas', async () => {
    supabaseStub = makeSupabaseStub({
      zones: {
        rows: [
          { id: 'poblado', archived: false, company_id: COMPANY_ID },
          { id: 'vieja', archived: true, company_id: COMPANY_ID },
        ],
      },
    });
    const res = await GET(getRequest('http://x/api/bros-and-subs/zones?all=1'), params);
    const body = await res.json();
    expect((body.zones as ZoneRow[]).map(z => z.id).sort()).toEqual(['poblado', 'vieja']);
  });
});

describe('POST /api/:companyId/zones', () => {
  it('crea con id = slug del nombre (sin acentos), recargo 0 y company_id', async () => {
    supabaseStub = makeSupabaseStub({
      zones: {
        rows: [], // sin colisión de id
        onInsert: (p: unknown) => { insertCapture(p); return { data: { ...(p as object), archived: false } }; },
      },
    });
    const res = await POST(jsonRequest('http://x/api/bros-and-subs/zones', 'POST', { name: 'La América', tarifa: 6000 }), params);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const inserted = insertCapture.mock.calls[0][0] as { id: string; tarifa: number; recargo: number; company_id: string };
    expect(inserted.id).toBe('la-america');
    expect(inserted.tarifa).toBe(6000);
    expect(inserted.recargo).toBe(0);
    expect(inserted.company_id).toBe(COMPANY_ID);
  });

  it('si el slug choca (dentro de la empresa), agrega sufijo numérico', async () => {
    supabaseStub = makeSupabaseStub({
      zones: {
        rows: [{ id: 'belen', company_id: COMPANY_ID }], // ya existe 'belen'
        onInsert: (p: unknown) => { insertCapture(p); return { data: p }; },
      },
    });
    const res = await POST(jsonRequest('http://x/api/bros-and-subs/zones', 'POST', { name: 'Belén', tarifa: 5000 }), params);
    expect(res.status).toBe(201);
    expect((insertCapture.mock.calls[0][0] as { id: string }).id).toBe('belen-2');
  });

  it('400 si falta name o tarifa', async () => {
    supabaseStub = makeSupabaseStub({ zones: {} });
    const res = await POST(jsonRequest('http://x/api/bros-and-subs/zones', 'POST', { name: '' }), params);
    expect(res.status).toBe(400);
  });
});

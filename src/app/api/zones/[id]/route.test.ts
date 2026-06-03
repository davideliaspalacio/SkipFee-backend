import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub, jsonRequest, asyncParams } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const updateCapture = vi.fn();

vi.mock('@/lib/db', () => ({ supabaseAdmin: () => supabaseStub.client }));

import { PATCH, DELETE } from './route';

beforeEach(() => {
  updateCapture.mockReset();
});

describe('PATCH /api/zones/:id', () => {
  it('edita name + tarifa (name ahora es editable)', async () => {
    supabaseStub = makeSupabaseStub({
      zones: {
        onUpdate: (p: unknown) => {
          updateCapture(p);
          return { data: { id: 'poblado', name: 'Poblado Nuevo', tarifa: 7000, archived: false } };
        },
      },
    });
    const res = await PATCH(
      jsonRequest('http://x/api/zones/poblado', 'PATCH', { name: 'Poblado Nuevo', tarifa: 7000 }),
      asyncParams({ id: 'poblado' }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(updateCapture.mock.calls[0][0]).toEqual({ name: 'Poblado Nuevo', tarifa: 7000 });
  });

  it('desarchiva con archived:false', async () => {
    supabaseStub = makeSupabaseStub({
      zones: { onUpdate: (p: unknown) => { updateCapture(p); return { data: { id: 'poblado', archived: false } }; } },
    });
    const res = await PATCH(
      jsonRequest('http://x/api/zones/poblado', 'PATCH', { archived: false }),
      asyncParams({ id: 'poblado' }),
    );
    expect(res.status).toBe(200);
    expect(updateCapture.mock.calls[0][0]).toEqual({ archived: false });
  });

  it('400 sin campos', async () => {
    supabaseStub = makeSupabaseStub({ zones: {} });
    const res = await PATCH(jsonRequest('http://x/api/zones/poblado', 'PATCH', {}), asyncParams({ id: 'poblado' }));
    expect(res.status).toBe(400);
  });

  it('404 si la zona no existe', async () => {
    supabaseStub = makeSupabaseStub({ zones: { onUpdate: () => ({}), single: null } });
    const res = await PATCH(jsonRequest('http://x/api/zones/nope', 'PATCH', { tarifa: 1 }), asyncParams({ id: 'nope' }));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/zones/:id (archivar)', () => {
  it('archiva la zona (update archived=true)', async () => {
    supabaseStub = makeSupabaseStub({
      zones: { onUpdate: (p: unknown) => { updateCapture(p); return { data: { id: 'poblado' } }; } },
    });
    const res = await DELETE(jsonRequest('http://x/api/zones/poblado', 'DELETE', {}), asyncParams({ id: 'poblado' }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(updateCapture.mock.calls[0][0]).toEqual({ archived: true });
  });

  it('404 si la zona no existe', async () => {
    supabaseStub = makeSupabaseStub({ zones: { onUpdate: () => ({}), single: null } });
    const res = await DELETE(jsonRequest('http://x/api/zones/nope', 'DELETE', {}), asyncParams({ id: 'nope' }));
    expect(res.status).toBe(404);
  });
});

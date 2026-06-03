import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub, jsonRequest, getRequest } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const insertCapture = vi.fn();

vi.mock('@/lib/db', () => ({ supabaseAdmin: () => supabaseStub.client }));

import { GET, POST } from './route';

interface ZoneRow { id: string; archived?: boolean }

beforeEach(() => {
  insertCapture.mockReset();
});

describe('GET /api/zones', () => {
  it('excluye archivadas por defecto', async () => {
    supabaseStub = makeSupabaseStub({
      zones: {
        rows: [
          { id: 'poblado', name: 'El Poblado', tarifa: 4500, archived: false },
          { id: 'vieja', name: 'Vieja', tarifa: 5000, archived: true },
        ],
      },
    });
    const res = await GET(getRequest('http://x/api/zones'));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect((body.zones as ZoneRow[]).map(z => z.id)).toEqual(['poblado']);
  });

  it('?all=1 incluye archivadas', async () => {
    supabaseStub = makeSupabaseStub({
      zones: {
        rows: [
          { id: 'poblado', archived: false },
          { id: 'vieja', archived: true },
        ],
      },
    });
    const res = await GET(getRequest('http://x/api/zones?all=1'));
    const body = await res.json();
    expect((body.zones as ZoneRow[]).map(z => z.id).sort()).toEqual(['poblado', 'vieja']);
  });
});

describe('POST /api/zones', () => {
  it('crea con id = slug del nombre (sin acentos) y recargo 0', async () => {
    supabaseStub = makeSupabaseStub({
      zones: {
        rows: [], // sin colisión de id
        onInsert: (p: unknown) => { insertCapture(p); return { data: { ...(p as object), archived: false } }; },
      },
    });
    const res = await POST(jsonRequest('http://x/api/zones', 'POST', { name: 'La América', tarifa: 6000 }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const inserted = insertCapture.mock.calls[0][0] as { id: string; tarifa: number; recargo: number };
    expect(inserted.id).toBe('la-america');
    expect(inserted.tarifa).toBe(6000);
    expect(inserted.recargo).toBe(0);
  });

  it('si el slug choca, agrega sufijo numérico', async () => {
    supabaseStub = makeSupabaseStub({
      zones: {
        rows: [{ id: 'belen' }], // ya existe 'belen'
        onInsert: (p: unknown) => { insertCapture(p); return { data: p }; },
      },
    });
    const res = await POST(jsonRequest('http://x/api/zones', 'POST', { name: 'Belén', tarifa: 5000 }));
    expect(res.status).toBe(201);
    expect((insertCapture.mock.calls[0][0] as { id: string }).id).toBe('belen-2');
  });

  it('400 si falta name o tarifa', async () => {
    supabaseStub = makeSupabaseStub({ zones: {} });
    const res = await POST(jsonRequest('http://x/api/zones', 'POST', { name: '' }));
    expect(res.status).toBe(400);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeSupabaseStub } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const updateCapture = vi.fn();

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => supabaseStub.client,
}));

import { POST } from './route';

const URL = 'http://localhost:3000/api/cron/expire-drafts';

function req(secret?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== undefined) headers['x-cron-secret'] = secret;
  return new Request(URL, { method: 'POST', headers, body: '{}' }) as never;
}

// `rows` = los borradores vencidos que el UPDATE ... RETURNING devolvería.
// Multi-empresa: el cron itera `companies` activas; declaramos una para que el
// UPDATE scopeado por company_id se ejecute.
function stubWithExpired(rows: unknown[]) {
  return makeSupabaseStub({
    companies: { rows: [{ id: 'c1', status: 'active' }] },
    orders: {
      onUpdate: (payload: unknown, filters: Record<string, unknown>) => {
        updateCapture(payload, filters);
        return { data: rows };
      },
    },
  });
}

const ORIGINAL = process.env.CRON_SECRET;
beforeEach(() => {
  process.env.CRON_SECRET = 'secret-123';
  updateCapture.mockReset();
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe('POST /api/cron/expire-drafts', () => {
  it('sin CRON_SECRET configurado ⇒ 503', async () => {
    delete process.env.CRON_SECRET;
    supabaseStub = stubWithExpired([]);
    const res = await POST(req('whatever'));
    expect(res.status).toBe(503);
  });

  it('secret incorrecto ⇒ 401', async () => {
    supabaseStub = stubWithExpired([]);
    const res = await POST(req('mal'));
    expect(res.status).toBe(401);
    expect(updateCapture).not.toHaveBeenCalled();
  });

  it('sin header x-cron-secret ⇒ 401', async () => {
    supabaseStub = stubWithExpired([]);
    const res = await POST(req(undefined));
    expect(res.status).toBe(401);
  });

  it('secret correcto ⇒ marca borradores vencidos como expirado', async () => {
    supabaseStub = stubWithExpired([{ id: 'o1' }, { id: 'o2' }]);
    const res = await POST(req('secret-123'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.expired).toBe(2);

    // El update setea status=expirado y filtra por status=borrador + vencidas.
    expect(updateCapture).toHaveBeenCalled();
    const [payload, filters] = updateCapture.mock.calls[0];
    expect(payload.status).toBe('expirado');
    expect(filters.status).toBe('borrador');
    // scopeado por empresa
    expect(filters.company_id).toBe('c1');
    // filtró por expires_at < ahora (lt)
    expect(Object.keys(filters).some(k => k.startsWith('expires_at'))).toBe(true);
  });

  it('sin borradores vencidos ⇒ expired 0', async () => {
    supabaseStub = stubWithExpired([]);
    const res = await POST(req('secret-123'));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.expired).toBe(0);
  });
});

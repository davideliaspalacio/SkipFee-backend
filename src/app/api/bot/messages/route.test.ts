import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
vi.mock('@/lib/db', () => ({ supabaseAdmin: () => supabaseStub.client }));

import { GET } from './route';
import { invalidateCatalog } from '@/lib/bot/messages/catalog';
import { MESSAGE_DEFS_LIST } from '@/lib/bot/messages/defaults';

interface AdminMsg {
  key: string;
  kind: string;
  category: string;
  isCustomized: boolean;
  enabled: boolean;
  variables: string[];
  content: { body?: string };
  defaultContent: { body?: string };
}

beforeEach(() => {
  supabaseStub = makeSupabaseStub({ bot_messages: { rows: [] } });
  invalidateCatalog();
});

describe('GET /api/bot/messages', () => {
  it('devuelve todo el catálogo con metadata', async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.messages).toHaveLength(MESSAGE_DEFS_LIST.length);

    const saludo = (body.messages as AdminMsg[]).find(m => m.key === 'saludo.nuevo')!;
    expect(saludo).toMatchObject({ kind: 'text', category: 'conversacion', isCustomized: false, enabled: true });
    expect(saludo.content.body).toContain('Quihubo');
    expect(saludo.variables).toContain('nombre');
  });

  it('marca isCustomized y devuelve el content override + el default de referencia', async () => {
    supabaseStub = makeSupabaseStub({
      bot_messages: { rows: [{ key: 'saludo.nuevo', content: { body: 'Hey {{nombre}}!' }, enabled: true }] },
    });
    invalidateCatalog();
    const res = await GET();
    const body = await res.json();
    const saludo = (body.messages as AdminMsg[]).find(m => m.key === 'saludo.nuevo')!;
    expect(saludo.isCustomized).toBe(true);
    expect(saludo.content.body).toBe('Hey {{nombre}}!');
    expect(saludo.defaultContent.body).toContain('Soy el bot de Bros and Subs');
  });
});

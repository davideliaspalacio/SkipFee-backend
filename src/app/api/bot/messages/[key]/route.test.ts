import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub, jsonRequest, asyncParams } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const upsertCapture = vi.fn();
const deleteCapture = vi.fn();

vi.mock('@/lib/db', () => ({ supabaseAdmin: () => supabaseStub.client }));

import { PATCH, DELETE } from './route';
import { invalidateCatalog } from '@/lib/bot/messages/catalog';

beforeEach(() => {
  upsertCapture.mockReset();
  deleteCapture.mockReset();
  supabaseStub = makeSupabaseStub({
    bot_messages: {
      single: null, // sin override existente
      onUpsert: (p: unknown) => { upsertCapture(p); return {}; },
      onDelete: () => { deleteCapture(); return {}; },
    },
  });
  invalidateCatalog();
});

function patchReq(key: string, bodyObj: unknown) {
  return PATCH(jsonRequest(`http://x/api/bot/messages/${key}`, 'PATCH', bodyObj), asyncParams({ key }));
}

describe('PATCH /api/bot/messages/:key', () => {
  it('guarda el body editado de un mensaje de texto', async () => {
    const res = await patchReq('registro.gracias', { content: { body: '¡Mil gracias!' } });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(upsertCapture).toHaveBeenCalled();
    const payload = upsertCapture.mock.calls[0][0] as { key: string; content: unknown; enabled: boolean };
    expect(payload.key).toBe('registro.gracias');
    expect(payload.content).toEqual({ body: '¡Mil gracias!' });
    expect(payload.enabled).toBe(true);
  });

  it('acepta editar solo el título del botón (mismo id)', async () => {
    const res = await patchReq('menu.pedir', {
      content: { body: '¿Arrancamos?', buttons: [{ id: 'menu_pedir', title: 'Pedir ya 🥪' }] },
    });
    expect((await res.json()).ok).toBe(true);
  });

  it('rechaza título de botón > 20 chars', async () => {
    const res = await patchReq('menu.pedir', {
      content: { body: '¿Pedimos?', buttons: [{ id: 'menu_pedir', title: 'Texto larguísimo de más de veinte' }] },
    });
    expect(res.status).toBe(400);
    expect(upsertCapture).not.toHaveBeenCalled();
  });

  it('rechaza cambiar el id de un botón', async () => {
    const res = await patchReq('menu.pedir', {
      content: { body: 'x', buttons: [{ id: 'otro_id', title: 'Pedir' }] },
    });
    expect(res.status).toBe(400);
    expect(upsertCapture).not.toHaveBeenCalled();
  });

  it('toggle enabled sin content guarda el default + enabled=false', async () => {
    const res = await patchReq('nudge.menu', { enabled: false });
    expect((await res.json()).ok).toBe(true);
    const payload = upsertCapture.mock.calls[0][0] as { content: { body: string }; enabled: boolean };
    expect(payload.enabled).toBe(false);
    expect(payload.content.body).toContain('Hacer pedido'); // default preservado
  });

  it('variable no declarada ⇒ warning, no bloquea', async () => {
    const res = await patchReq('registro.gracias', { content: { body: 'Gracias {{desconocida}}' } });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.warnings?.[0]).toContain('desconocida');
  });

  it('sin content ni enabled ⇒ 400', async () => {
    const res = await patchReq('registro.gracias', {});
    expect(res.status).toBe(400);
  });

  it('key inexistente ⇒ 404', async () => {
    const res = await patchReq('no.existe', { content: { body: 'x' } });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/bot/messages/:key (reset)', () => {
  it('borra el override y responde ok', async () => {
    const res = await DELETE(
      jsonRequest('http://x/api/bot/messages/saludo.nuevo', 'DELETE', {}),
      asyncParams({ key: 'saludo.nuevo' }),
    );
    expect((await res.json()).ok).toBe(true);
    expect(deleteCapture).toHaveBeenCalled();
  });

  it('key inexistente ⇒ 404', async () => {
    const res = await DELETE(jsonRequest('http://x', 'DELETE', {}), asyncParams({ key: 'no.existe' }));
    expect(res.status).toBe(404);
  });
});

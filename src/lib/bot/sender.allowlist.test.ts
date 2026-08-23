import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lo que se prueba acá no es la lista blanca en sí (eso está en
 * `lib/whatsapp/allowlist.test.ts`), sino la propiedad que de verdad protege a
 * un cliente real: que con el filtro activo NO se toque al proveedor. Si el
 * envío llegara al adaptador, el mensaje ya salió por el aire y no hay vuelta
 * atrás — que la función devuelva vacío después sería un consuelo inútil.
 */

const sendText = vi.fn(async () => ({ messages: [{ id: 'x' }] }));
const providerFor = vi.fn(async () => ({ sendText }));

vi.mock('@/lib/whatsapp', () => ({ providerFor }));
vi.mock('@/lib/kapso/client', () => ({ sendText: vi.fn(), sendImage: vi.fn() }));
vi.mock('@/lib/kapso/interactive', () => ({
  sendButtons: vi.fn(),
  sendList: vi.fn(),
  sendCtaUrl: vi.fn(),
}));

const original = process.env.WHATSAPP_ALLOWLIST;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHATSAPP_ALLOWLIST = '3013589021';
});

afterEach(() => {
  if (original === undefined) delete process.env.WHATSAPP_ALLOWLIST;
  else process.env.WHATSAPP_ALLOWLIST = original;
});

describe('sender con lista blanca activa', () => {
  it('no llama al proveedor para un número que no está en la lista', async () => {
    const { botSendTextMsg } = await import('./sender');
    const res = await botSendTextMsg('empresa-1', '573001112233', 'hola');

    expect(providerFor).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(res).toEqual({});
  });

  it('sí envía al número permitido, venga como venga escrito', async () => {
    const { botSendTextMsg } = await import('./sender');
    await botSendTextMsg('empresa-1', '573013589021', 'hola');

    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith({ to: '573013589021', body: 'hola' });
  });

  it('sin filtro, no se interpone en nada', async () => {
    delete process.env.WHATSAPP_ALLOWLIST;
    const { botSendTextMsg } = await import('./sender');
    await botSendTextMsg('empresa-1', '573001112233', 'hola');

    expect(sendText).toHaveBeenCalledOnce();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const sendTextMock = vi.fn();
const sendCtaUrlMock = vi.fn();
const sendButtonsMock = vi.fn();
const recordMessageMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('@/lib/db', () => ({ supabaseAdmin: () => supabaseStub.client }));
vi.mock('@/lib/kapso/client', () => ({ sendText: (...a: unknown[]) => sendTextMock(...a) }));
vi.mock('@/lib/kapso/interactive', () => ({
  sendCtaUrl: (...a: unknown[]) => sendCtaUrlMock(...a),
  sendButtons: (...a: unknown[]) => sendButtonsMock(...a),
  sendList: vi.fn(),
}));
vi.mock('@/lib/messaging', () => ({ recordMessage: (...a: unknown[]) => recordMessageMock(...a) }));

import { enviarLinkPedido, handleMenu, type HandlerContext } from './handlers';
import { routeFlow } from './index';
import type { IncomingMessage } from './parser';

function ctxOf(incoming: IncomingMessage, step = 'menu'): HandlerContext {
  return {
    chatId: 'wa:573136913188',
    phone: '573136913188',
    state: { step: step as never },
    incoming,
  };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_ORIGIN = 'http://localhost:3000';
  supabaseStub = makeSupabaseStub({
    customers: { single: null },
    chats: { onUpdate: () => ({}) },
  });
  sendTextMock.mockReset().mockResolvedValue({ messages: [{ id: 'wamid-1' }] });
  sendCtaUrlMock.mockReset().mockResolvedValue({ messages: [{ id: 'wamid-2' }] });
  sendButtonsMock.mockReset().mockResolvedValue({ messages: [{ id: 'wamid-3' }] });
  recordMessageMock.mockReset().mockResolvedValue({ chatId: 'wa:573136913188' });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('enviarLinkPedido', () => {
  it('crea sesión de checkout y manda el CTA URL con el link', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: true,
        orderId: 'uuid-1',
        url: 'http://localhost:5173/pedir?orderId=uuid-1&userId=573136913188',
      }),
    });

    const next = await enviarLinkPedido(ctxOf({ buttonReplyId: 'menu_pedir' }));

    // Llamó al endpoint interno de sesiones con el phone
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/checkout/sessions',
      expect.objectContaining({ method: 'POST' }),
    );
    const fetchBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(fetchBody.phone).toBe('573136913188');

    // Mandó el CTA URL con el botón "Ver carta y pedir 🛒" y el url de la sesión
    expect(sendCtaUrlMock).toHaveBeenCalledTimes(1);
    const cta = sendCtaUrlMock.mock.calls[0][0];
    expect(cta.url).toBe('http://localhost:5173/pedir?orderId=uuid-1&userId=573136913188');
    expect(cta.displayText).toBe('Ver carta y pedir 🛒');

    expect(next.step).toBe('link_enviado');
    expect(next.orderId).toBe('uuid-1');
  });

  it('si la sesión falla ⇒ avisa y vuelve al menú (no manda link)', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: false, error: 'boom' }) });
    const next = await enviarLinkPedido(ctxOf({ buttonReplyId: 'menu_pedir' }));
    expect(sendCtaUrlMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('no pude generar'));
    expect(next.step).toBe('menu');
  });

  it('si fetch lanza ⇒ degrada con mensaje y vuelve al menú', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    const next = await enviarLinkPedido(ctxOf({ buttonReplyId: 'menu_pedir' }));
    expect(next.step).toBe('menu');
    expect(sendTextMock).toHaveBeenCalled();
  });
});

describe('handleMenu', () => {
  it('botón "menu_pedir" ⇒ manda el link', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ ok: true, orderId: 'u2', url: 'http://localhost:5173/pedir?orderId=u2&userId=573136913188' }),
    });
    const next = await handleMenu(ctxOf({ buttonReplyId: 'menu_pedir' }));
    expect(sendCtaUrlMock).toHaveBeenCalled();
    expect(next.step).toBe('link_enviado');
  });

  it('botón "menu_humano" ⇒ escala a humano', async () => {
    const next = await handleMenu(ctxOf({ buttonReplyId: 'menu_humano' }));
    expect(next.step).toBe('finalizado');
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('humano'));
  });
});

describe('routeFlow — intención de pedir desde cualquier step', () => {
  it('"Quiero hacer un pedido" (texto del botón carrito vencido) ⇒ enviarLinkPedido', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ ok: true, orderId: 'u3', url: 'http://localhost:5173/pedir?orderId=u3&userId=573136913188' }),
    });
    const next = await routeFlow(ctxOf({ text: 'Quiero hacer un pedido' }, 'link_enviado'));
    expect(sendCtaUrlMock).toHaveBeenCalled();
    expect(next.step).toBe('link_enviado');
  });

  it('"asesor" ⇒ escala a humano (keyword global) sin mandar link', async () => {
    const next = await routeFlow(ctxOf({ text: 'asesor' }, 'menu'));
    expect(next.step).toBe('finalizado');
    expect(sendCtaUrlMock).not.toHaveBeenCalled();
  });
});

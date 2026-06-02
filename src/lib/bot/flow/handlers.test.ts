import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const sendTextMock = vi.fn();
const sendCtaUrlMock = vi.fn();
const sendButtonsMock = vi.fn();
const sendListMock = vi.fn();
const recordMessageMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('@/lib/db', () => ({ supabaseAdmin: () => supabaseStub.client }));
vi.mock('@/lib/kapso/client', () => ({ sendText: (...a: unknown[]) => sendTextMock(...a) }));
vi.mock('@/lib/kapso/interactive', () => ({
  sendCtaUrl: (...a: unknown[]) => sendCtaUrlMock(...a),
  sendButtons: (...a: unknown[]) => sendButtonsMock(...a),
  sendList: (...a: unknown[]) => sendListMock(...a),
}));
vi.mock('@/lib/messaging', () => ({ recordMessage: (...a: unknown[]) => recordMessageMock(...a) }));

import {
  enviarLinkPedido,
  handleMenu,
  iniciarPedido,
  handleRegistroNombre,
  handleRegistroEmail,
  handleRegistroConfirmar,
  handleDireccionTexto,
  handleDireccionZona,
  handleDireccionConfirmar,
  handleConfirmarRecurrente,
  type HandlerContext,
} from './handlers';
import { routeFlow } from './index';
import type { IncomingMessage } from './parser';
import type { FlowState } from './state';

function ctxOf(incoming: IncomingMessage, state: Partial<FlowState> = {}): HandlerContext {
  return {
    chatId: 'wa:573136913188',
    phone: '573136913188',
    state: { step: 'menu' as FlowState['step'], ...state },
    incoming,
  };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_ORIGIN = 'http://localhost:3000';
  // Default stub: customer nuevo (no existe) + chats.update OK
  supabaseStub = makeSupabaseStub({
    customers: { single: null },
    chats: { onUpdate: () => ({}) },
    zones: { rows: [
      { id: 'poblado', name: 'El Poblado', tarifa: 4500 },
      { id: 'envigado', name: 'Envigado', tarifa: 5500 },
    ] },
  });
  sendTextMock.mockReset().mockResolvedValue({ messages: [{ id: 'wamid-1' }] });
  sendCtaUrlMock.mockReset().mockResolvedValue({ messages: [{ id: 'wamid-2' }] });
  sendButtonsMock.mockReset().mockResolvedValue({ messages: [{ id: 'wamid-3' }] });
  sendListMock.mockReset().mockResolvedValue({ messages: [{ id: 'wamid-4' }] });
  recordMessageMock.mockReset().mockResolvedValue({ chatId: 'wa:573136913188' });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('iniciarPedido — decide nuevo vs recurrente', () => {
  it('cliente NUEVO (sin customer) ⇒ va a registro_nombre con copy "primera vez"', async () => {
    supabaseStub = makeSupabaseStub({ customers: { single: null } });
    const next = await iniciarPedido(ctxOf({ buttonReplyId: 'menu_pedir' }));
    expect(next.step).toBe('registro_nombre');
    expect(sendTextMock).toHaveBeenCalledWith(
      '573136913188',
      expect.stringContaining('primera vez'),
    );
    expect(sendTextMock).toHaveBeenCalledWith(
      '573136913188',
      expect.stringContaining('nombre completo'),
    );
  });

  it('cliente RECURRENTE (con datos completos) ⇒ confirmar_recurrente con botones', async () => {
    supabaseStub = makeSupabaseStub({
      customers: { single: {
        id: 'cust-1', name: 'Edison Bedoya', email: 'edison@gmail.com',
        addr: 'Cra 43A #5-15', zone_id: 'poblado',
      } },
      zones: { single: { name: 'El Poblado', tarifa: 4500 } },
    });
    const next = await iniciarPedido(ctxOf({ buttonReplyId: 'menu_pedir' }));
    expect(next.step).toBe('confirmar_recurrente');
    expect(next.customer?.name).toBe('Edison Bedoya');
    expect(next.delivery?.address).toBe('Cra 43A #5-15');
    expect(sendButtonsMock).toHaveBeenCalledTimes(1);
    const opts = sendButtonsMock.mock.calls[0][0];
    expect(opts.body).toContain('Edison');
    expect(opts.body).toContain('Cra 43A #5-15');
    expect(opts.buttons).toHaveLength(2); // Sí / Cambiar dir
  });
});

describe('Path RECURRENTE', () => {
  it('"Sí, igual" ⇒ enviarLinkPedido con datos del state', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ ok: true, orderId: 'u1', url: 'http://localhost:5173/pedir?orderId=u1&userId=573136913188' }),
    });
    const ctx = ctxOf(
      { buttonReplyId: 'rec_si' },
      { step: 'confirmar_recurrente',
        customer: { name: 'Edison', email: 'edison@gmail.com' },
        delivery: { address: 'Cra 43A', zoneId: 'poblado' } },
    );
    const next = await handleConfirmarRecurrente(ctx);
    expect(next.step).toBe('link_enviado');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.customer).toEqual({ name: 'Edison', email: 'edison@gmail.com' });
    expect(body.delivery).toEqual({ address: 'Cra 43A', zoneId: 'poblado' });
  });

  it('"Cambiar dir" ⇒ vuelve a direccion_texto', async () => {
    const ctx = ctxOf(
      { buttonReplyId: 'rec_cambiar' },
      { step: 'confirmar_recurrente', customer: { name: 'Edison' }, delivery: { address: 'vieja', zoneId: 'poblado' } },
    );
    const next = await handleConfirmarRecurrente(ctx);
    expect(next.step).toBe('direccion_texto');
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('nueva dirección'));
  });
});

describe('Path REGISTRO (cliente nuevo)', () => {
  it('handleRegistroNombre ⇒ guarda nombre y pide email', async () => {
    const next = await handleRegistroNombre(ctxOf({ text: 'Edison Bedoya' }, { step: 'registro_nombre', customer: {} }));
    expect(next.step).toBe('registro_email');
    expect(next.customer?.name).toBe('Edison Bedoya');
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', '¡Gracias!');
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('correo'));
  });

  it('handleRegistroNombre con nombre muy corto ⇒ se queda en el step y re-pregunta', async () => {
    const next = await handleRegistroNombre(ctxOf({ text: 'a' }, { step: 'registro_nombre', customer: {} }));
    expect(next.step).toBe('registro_nombre');
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('nombre completo'));
  });

  it('handleRegistroEmail ⇒ guarda email y muestra confirm con botones', async () => {
    const next = await handleRegistroEmail(ctxOf(
      { text: 'edison@gmail.com' },
      { step: 'registro_email', customer: { name: 'Edison Bedoya' } },
    ));
    expect(next.step).toBe('registro_confirmar');
    expect(next.customer?.email).toBe('edison@gmail.com');
    const opts = sendButtonsMock.mock.calls[0][0];
    expect(opts.body).toContain('Edison Bedoya');
    expect(opts.body).toContain('edison@gmail.com');
    expect(opts.body).toContain('¿Están correctos');
  });

  it('handleRegistroEmail con formato inválido ⇒ re-pregunta', async () => {
    const next = await handleRegistroEmail(ctxOf(
      { text: 'no-es-email' },
      { step: 'registro_email', customer: { name: 'Edison' } },
    ));
    expect(next.step).toBe('registro_email');
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('no es válido'));
  });

  it('handleRegistroConfirmar "Sí" ⇒ avanza a direccion_texto', async () => {
    const next = await handleRegistroConfirmar(ctxOf(
      { buttonReplyId: 'reg_si' },
      { step: 'registro_confirmar', customer: { name: 'Edison', email: 'e@e.co' } },
    ));
    expect(next.step).toBe('direccion_texto');
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('dirección'));
  });

  it('handleRegistroConfirmar "No" ⇒ vuelve a registro_nombre y limpia customer', async () => {
    const next = await handleRegistroConfirmar(ctxOf(
      { buttonReplyId: 'reg_no' },
      { step: 'registro_confirmar', customer: { name: 'Edison', email: 'e@e.co' } },
    ));
    expect(next.step).toBe('registro_nombre');
    expect(next.customer).toEqual({});
  });
});

describe('Path DIRECCIÓN', () => {
  it('handleDireccionTexto ⇒ guarda dirección y muestra lista de zonas', async () => {
    const next = await handleDireccionTexto(ctxOf(
      { text: 'Cra 43A #5-15' },
      { step: 'direccion_texto', customer: { name: 'E', email: 'e@e.co' }, delivery: {} },
    ));
    expect(next.step).toBe('direccion_zona');
    expect(next.delivery?.address).toBe('Cra 43A #5-15');
    expect(sendListMock).toHaveBeenCalledTimes(1);
    const opts = sendListMock.mock.calls[0][0];
    expect(opts.sections[0].rows.length).toBeGreaterThan(0);
    expect(opts.sections[0].rows[0].id).toMatch(/^zone_/);
  });

  it('handleDireccionTexto con dirección muy corta ⇒ se queda y re-pregunta', async () => {
    const next = await handleDireccionTexto(ctxOf(
      { text: 'ab' },
      { step: 'direccion_texto', delivery: {} },
    ));
    expect(next.step).toBe('direccion_texto');
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('más detallada'));
  });

  it('handleDireccionZona ⇒ guarda zona y muestra confirmación', async () => {
    supabaseStub = makeSupabaseStub({
      zones: { single: { id: 'poblado', name: 'El Poblado', tarifa: 4500 } },
    });
    const next = await handleDireccionZona(ctxOf(
      { listReplyId: 'zone_poblado' },
      { step: 'direccion_zona', delivery: { address: 'Cra 43A' } },
    ));
    expect(next.step).toBe('direccion_confirmar');
    expect(next.delivery?.zoneId).toBe('poblado');
    const opts = sendButtonsMock.mock.calls[0][0];
    expect(opts.body).toContain('Cra 43A');
    expect(opts.body).toContain('El Poblado');
  });

  it('handleDireccionConfirmar "Sí, correcta" ⇒ enviarLinkPedido', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ ok: true, orderId: 'u2', url: 'http://localhost:5173/pedir?orderId=u2&userId=573136913188' }),
    });
    const next = await handleDireccionConfirmar(ctxOf(
      { buttonReplyId: 'dir_si' },
      { step: 'direccion_confirmar',
        customer: { name: 'Edison', email: 'edison@gmail.com' },
        delivery: { address: 'Cra 43A', zoneId: 'poblado' } },
    ));
    expect(next.step).toBe('link_enviado');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.customer.name).toBe('Edison');
    expect(body.delivery.address).toBe('Cra 43A');
  });

  it('handleDireccionConfirmar "Editar" ⇒ vuelve a direccion_texto y limpia address', async () => {
    const next = await handleDireccionConfirmar(ctxOf(
      { buttonReplyId: 'dir_editar' },
      { step: 'direccion_confirmar', delivery: { address: 'vieja', zoneId: 'poblado' } },
    ));
    expect(next.step).toBe('direccion_texto');
    expect(next.delivery?.address).toBeUndefined();
    expect(next.delivery?.zoneId).toBe('poblado'); // zona se preserva (recargarán al volver)
  });
});

describe('enviarLinkPedido', () => {
  it('manda el body completo (phone + customer + delivery) cuando el state los tiene', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ ok: true, orderId: 'uuid-x', url: 'http://localhost:5173/pedir?orderId=uuid-x&userId=573136913188' }),
    });
    const next = await enviarLinkPedido(ctxOf(
      { buttonReplyId: 'dir_si' },
      { step: 'direccion_confirmar',
        customer: { name: 'Edison', email: 'edison@gmail.com' },
        delivery: { address: 'Cra 43A', zoneId: 'poblado' } },
    ));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.phone).toBe('573136913188');
    expect(body.customer).toEqual({ name: 'Edison', email: 'edison@gmail.com' });
    expect(body.delivery).toEqual({ address: 'Cra 43A', zoneId: 'poblado' });

    expect(sendCtaUrlMock).toHaveBeenCalledTimes(1);
    expect(next.step).toBe('link_enviado');
    expect(next.orderId).toBe('uuid-x');
  });

  it('si solo viene phone (sin customer/delivery), igual manda el link (compat)', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ ok: true, orderId: 'u', url: 'http://localhost:5173/pedir?orderId=u&userId=573136913188' }),
    });
    const next = await enviarLinkPedido(ctxOf({ text: 'hola' }, { step: 'menu' }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.phone).toBe('573136913188');
    expect(body.customer).toBeUndefined();
    expect(body.delivery).toBeUndefined();
    expect(next.step).toBe('link_enviado');
  });

  it('si la sesión falla ⇒ avisa y vuelve al menú', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: false, error: 'boom' }) });
    const next = await enviarLinkPedido(ctxOf({ buttonReplyId: 'menu_pedir' }));
    expect(sendCtaUrlMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('no pude generar'));
    expect(next.step).toBe('menu');
  });
});

describe('handleMenu', () => {
  it('botón "menu_pedir" ⇒ iniciarPedido (cliente nuevo va a registro)', async () => {
    supabaseStub = makeSupabaseStub({ customers: { single: null } });
    const next = await handleMenu(ctxOf({ buttonReplyId: 'menu_pedir' }));
    expect(next.step).toBe('registro_nombre');
  });

  it('botón "menu_humano" ⇒ escala a humano', async () => {
    const next = await handleMenu(ctxOf({ buttonReplyId: 'menu_humano' }));
    expect(next.step).toBe('finalizado');
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('humano'));
  });
});

describe('routeFlow — keywords globales', () => {
  it('"Quiero hacer un pedido" desde cualquier step ⇒ iniciarPedido', async () => {
    supabaseStub = makeSupabaseStub({ customers: { single: null } });
    const next = await routeFlow(ctxOf({ text: 'Quiero hacer un pedido' }, { step: 'link_enviado' }));
    expect(next.step).toBe('registro_nombre'); // cliente nuevo → registro
  });

  it('"asesor" ⇒ escala a humano sin pasar por iniciarPedido', async () => {
    const next = await routeFlow(ctxOf({ text: 'asesor' }, { step: 'menu' }));
    expect(next.step).toBe('finalizado');
    expect(sendCtaUrlMock).not.toHaveBeenCalled();
  });

  it('"cambiar dirección" ⇒ vuelve a direccion_texto preservando customer', async () => {
    const next = await routeFlow(ctxOf(
      { text: 'cambiar dirección' },
      { step: 'link_enviado',
        customer: { name: 'Edison', email: 'edison@gmail.com' },
        delivery: { address: 'vieja', zoneId: 'poblado' } },
    ));
    expect(next.step).toBe('direccion_texto');
    expect(next.customer?.name).toBe('Edison'); // se preserva
    expect(next.delivery?.address).toBeUndefined();
  });
});

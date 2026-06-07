import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const sendTextMock = vi.fn();
const sendCtaUrlMock = vi.fn();
const sendButtonsMock = vi.fn();
const sendListMock = vi.fn();
const sendLocationRequestMock = vi.fn();
const recordMessageMock = vi.fn();
const fetchMock = vi.fn();
const geocodeMock = vi.fn();
const geocodingEnabledMock = vi.fn(() => true);
const resolveZoneMock = vi.fn();

vi.mock('@/lib/db', () => ({ supabaseAdmin: () => supabaseStub.client }));
vi.mock('@/lib/kapso/client', () => ({ sendText: (...a: unknown[]) => sendTextMock(...a) }));
vi.mock('@/lib/kapso/interactive', () => ({
  sendCtaUrl: (...a: unknown[]) => sendCtaUrlMock(...a),
  sendButtons: (...a: unknown[]) => sendButtonsMock(...a),
  sendList: (...a: unknown[]) => sendListMock(...a),
  sendLocationRequest: (...a: unknown[]) => sendLocationRequestMock(...a),
}));
vi.mock('@/lib/messaging', () => ({ recordMessage: (...a: unknown[]) => recordMessageMock(...a) }));
vi.mock('@/lib/geo/google', () => ({
  geocodeAddress: (...a: unknown[]) => geocodeMock(...a),
  geocodingEnabled: () => geocodingEnabledMock(),
}));
vi.mock('./zones', () => ({ resolveZoneFromLatLng: (...a: unknown[]) => resolveZoneMock(...a) }));
vi.mock('./gemini-fallback', () => ({
  assistOffScript: vi.fn(async () => ({ intent: 'continue', reply: 'usá los botones del último mensaje' })),
}));

import {
  enviarLinkPedido,
  handleMenu,
  handlePedidoEnCurso,
  iniciarPedido,
  handleRegistroNombre,
  handleRegistroEmail,
  handleRegistroConfirmar,
  handleDireccionTexto,
  handleDireccionZona,
  handleDireccionConfirmar,
  handleDireccionFueraCobertura,
  handleConfirmarRecurrente,
  handlePostventaEncuesta,
  handlePostventaResena,
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
      { id: 'poblado', name: 'El Poblado', tarifa: 4500, archived: false },
      { id: 'envigado', name: 'Envigado', tarifa: 5500, archived: false },
    ] },
  });
  sendTextMock.mockReset().mockResolvedValue({ messages: [{ id: 'wamid-1' }] });
  sendCtaUrlMock.mockReset().mockResolvedValue({ messages: [{ id: 'wamid-2' }] });
  sendButtonsMock.mockReset().mockResolvedValue({ messages: [{ id: 'wamid-3' }] });
  sendListMock.mockReset().mockResolvedValue({ messages: [{ id: 'wamid-4' }] });
  sendLocationRequestMock.mockReset().mockResolvedValue({ messages: [{ id: 'wamid-5' }] });
  recordMessageMock.mockReset().mockResolvedValue({ chatId: 'wa:573136913188' });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // Geocoding ON por defecto, confianza alta, zona resuelta = poblado.
  geocodeMock.mockReset().mockResolvedValue({
    lat: 6.2, lng: -75.56, formatted: 'Cra 43A #5-15, Medellín',
    locationType: 'ROOFTOP', partialMatch: false, confidence: 'alta',
  });
  geocodingEnabledMock.mockReset().mockReturnValue(true);
  resolveZoneMock.mockReset().mockResolvedValue({ zoneId: 'poblado', configured: true });
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

describe('pedido en curso — ofrecer estado vs nuevo pedido (Tarea 3)', () => {
  it('cliente con pedido sin entregar ⇒ ofrece ver estado / otro pedido (no arranca pedido)', async () => {
    supabaseStub = makeSupabaseStub({
      orders: { rows: [{ phone: '573136913188', order_number: 85, status: 'cocina' }] },
      customers: { single: null },
    });
    const next = await iniciarPedido(ctxOf({ buttonReplyId: 'menu_pedir' }));
    expect(next.step).toBe('pedido_en_curso');
    expect(sendButtonsMock).toHaveBeenCalledTimes(1);
    const opts = sendButtonsMock.mock.calls[0][0];
    expect(opts.body).toContain('#85');
    expect(opts.buttons.map((b: { id: string }) => b.id)).toEqual(['pedido_ver_estado', 'pedido_otro']);
  });

  it('"Ver mi pedido" ⇒ muestra el estado actual y termina', async () => {
    supabaseStub = makeSupabaseStub({ orders: { rows: [{ phone: '573136913188', order_number: 85, status: 'ruta' }] } });
    const next = await handlePedidoEnCurso(ctxOf({ buttonReplyId: 'pedido_ver_estado' }, { step: 'pedido_en_curso' }));
    expect(next.step).toBe('finalizado');
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('#85'));
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('camino'));
  });

  it('"Otro pedido" ⇒ arranca el flujo de pedido sin volver a preguntar', async () => {
    supabaseStub = makeSupabaseStub({
      orders: { rows: [{ phone: '573136913188', order_number: 85, status: 'cocina' }] },
      customers: { single: null },
    });
    const next = await handlePedidoEnCurso(ctxOf({ buttonReplyId: 'pedido_otro' }, { step: 'pedido_en_curso' }));
    expect(next.step).toBe('registro_nombre');
    expect(sendButtonsMock).not.toHaveBeenCalled(); // no volvió a ofrecer "pedido en curso"
  });

  it('sin pedido en curso ⇒ arranca el flujo normal', async () => {
    supabaseStub = makeSupabaseStub({ orders: { rows: [] }, customers: { single: null } });
    const next = await iniciarPedido(ctxOf({ buttonReplyId: 'menu_pedir' }));
    expect(next.step).toBe('registro_nombre');
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
    expect(body.delivery).toEqual({ address: 'Cra 43A', zoneId: 'poblado', persist: true });
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

describe('Path DIRECCIÓN (geocoding + 3 botones)', () => {
  it('geocode confiable + dentro de zona ⇒ direccion_confirmar (botones guardar/cambiar/no guardar)', async () => {
    supabaseStub = makeSupabaseStub({ zones: { single: { name: 'El Poblado', tarifa: 4500 } } });
    resolveZoneMock.mockResolvedValue({ zoneId: 'poblado', configured: true });
    const next = await handleDireccionTexto(ctxOf(
      { text: 'Cra 43A #5-15' },
      { step: 'direccion_texto', customer: { name: 'E', email: 'e@e.co' }, delivery: {} },
    ));
    expect(next.step).toBe('direccion_confirmar');
    expect(next.delivery?.address).toBe('Cra 43A #5-15');
    expect(next.delivery?.zoneId).toBe('poblado');
    expect(next.delivery?.lat).toBe(6.2);
    const opts = sendButtonsMock.mock.calls[0][0];
    expect(opts.buttons.map((b: { id: string }) => b.id)).toEqual([
      'dir_si_guardar', 'dir_editar', 'dir_si_no_guardar',
    ]);
  });

  it('geocode con confianza baja ⇒ selección manual de zona (lista)', async () => {
    geocodeMock.mockResolvedValue({
      lat: 6.2, lng: -75.5, formatted: 'x', locationType: 'APPROXIMATE', partialMatch: false, confidence: 'baja',
    });
    const next = await handleDireccionTexto(ctxOf(
      { text: 'por el centro' },
      { step: 'direccion_texto', delivery: {} },
    ));
    expect(next.step).toBe('direccion_zona');
    expect(next.delivery?.address).toBe('por el centro');
    expect(sendListMock).toHaveBeenCalledTimes(1);
  });

  it('geocode confiable, fuera de zona y con polígonos dibujados ⇒ direccion_fuera_cobertura', async () => {
    resolveZoneMock.mockResolvedValue({ zoneId: null, configured: true });
    const next = await handleDireccionTexto(ctxOf(
      { text: 'Bogotá centro' },
      { step: 'direccion_texto', delivery: {} },
    ));
    expect(next.step).toBe('direccion_fuera_cobertura');
    expect(sendButtonsMock).toHaveBeenCalledTimes(1);
  });

  it('sin geocoding configurado ⇒ camino manual (lista de zonas)', async () => {
    geocodingEnabledMock.mockReturnValue(false);
    const next = await handleDireccionTexto(ctxOf(
      { text: 'Cra 43A #5-15' },
      { step: 'direccion_texto', delivery: {} },
    ));
    expect(next.step).toBe('direccion_zona');
    expect(sendListMock).toHaveBeenCalledTimes(1);
    expect(geocodeMock).not.toHaveBeenCalled();
  });

  it('handleDireccionTexto con dirección muy corta ⇒ se queda y re-pregunta', async () => {
    const next = await handleDireccionTexto(ctxOf(
      { text: 'ab' },
      { step: 'direccion_texto', delivery: {} },
    ));
    expect(next.step).toBe('direccion_texto');
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('más detallada'));
  });

  it('geocode confiable pero sin polígonos configurados ⇒ selección manual de zona (conserva coords)', async () => {
    resolveZoneMock.mockResolvedValue({ zoneId: null, configured: false });
    const next = await handleDireccionTexto(ctxOf(
      { text: 'Cra 43A #5-15' },
      { step: 'direccion_texto', delivery: {} },
    ));
    expect(next.step).toBe('direccion_zona');
    expect(sendListMock).toHaveBeenCalledTimes(1);
    expect(next.delivery?.lat).toBe(6.2); // conserva las coords del geocode
  });

  it('handleDireccionZona (manual) ⇒ guarda zona y confirma', async () => {
    supabaseStub = makeSupabaseStub({ zones: { single: { id: 'poblado', name: 'El Poblado', tarifa: 4500 } } });
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

  it('"Sí y guardar" ⇒ enviarLink con persist=true (incluye lat/lng)', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ ok: true, orderId: 'u2', url: 'http://localhost:5173/pedir?orderId=u2&userId=573136913188' }),
    });
    const next = await handleDireccionConfirmar(ctxOf(
      { buttonReplyId: 'dir_si_guardar' },
      { step: 'direccion_confirmar',
        customer: { name: 'Edison', email: 'edison@gmail.com' },
        delivery: { address: 'Cra 43A', zoneId: 'poblado', lat: 6.2, lng: -75.56 } },
    ));
    expect(next.step).toBe('link_enviado');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.delivery.persist).toBe(true);
    expect(body.delivery.lat).toBe(6.2);
  });

  it('"Sí pero no guardar" ⇒ enviarLink con persist=false', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ ok: true, orderId: 'u3', url: 'http://localhost:5173/pedir?orderId=u3&userId=573136913188' }),
    });
    const next = await handleDireccionConfirmar(ctxOf(
      { buttonReplyId: 'dir_si_no_guardar' },
      { step: 'direccion_confirmar',
        customer: { name: 'E' },
        delivery: { address: 'Cra 43A', zoneId: 'poblado' } },
    ));
    expect(next.step).toBe('link_enviado');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.delivery.persist).toBe(false);
  });

  it('"Cambiar dirección" ⇒ vuelve a direccion_texto y limpia address/coords', async () => {
    const next = await handleDireccionConfirmar(ctxOf(
      { buttonReplyId: 'dir_editar' },
      { step: 'direccion_confirmar', delivery: { address: 'vieja', zoneId: 'poblado', lat: 6.2, lng: -75.5 } },
    ));
    expect(next.step).toBe('direccion_texto');
    expect(next.delivery?.address).toBeUndefined();
    expect(next.delivery?.lat).toBeUndefined();
  });

  it('fuera de cobertura → "Hablar con alguien" ⇒ escala a humano', async () => {
    const next = await handleDireccionFueraCobertura(ctxOf(
      { buttonReplyId: 'fuera_humano' },
      { step: 'direccion_fuera_cobertura', delivery: { address: 'lejos' } },
    ));
    expect(next.step).toBe('finalizado');
  });

  it('fuera de cobertura → "Otra dirección" ⇒ vuelve a direccion_texto', async () => {
    const next = await handleDireccionFueraCobertura(ctxOf(
      { buttonReplyId: 'fuera_cambiar' },
      { step: 'direccion_fuera_cobertura', delivery: { address: 'lejos' } },
    ));
    expect(next.step).toBe('direccion_texto');
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
    expect(body.delivery).toEqual({ address: 'Cra 43A', zoneId: 'poblado', persist: true });

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

describe('iniciarPedido — gate por horario / pausa', () => {
  const allClosed = Object.fromEntries(
    ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(d => [d, { closed: true }]),
  );

  it('cerrado por horario ⇒ avisa y NO inicia el pedido', async () => {
    supabaseStub = makeSupabaseStub({
      settings: { single: { hours: allClosed, orders_paused: false } },
      customers: { single: null },
    });
    const next = await iniciarPedido(ctxOf({ buttonReplyId: 'menu_pedir' }));
    expect(next.step).toBe('menu');
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('cerrados'));
    // No arranca el registro
    expect(sendTextMock).not.toHaveBeenCalledWith('573136913188', expect.stringContaining('nombre completo'));
  });

  it('pausado manualmente ⇒ avisa la pausa', async () => {
    supabaseStub = makeSupabaseStub({
      settings: { single: { hours: allClosed, orders_paused: true } },
    });
    const next = await iniciarPedido(ctxOf({ buttonReplyId: 'menu_pedir' }));
    expect(next.step).toBe('menu');
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('Pausamos'));
  });
});

describe('Path POST-VENTA (encuesta + reseña)', () => {
  it('encuesta rating 5 ⇒ invita a reseñar (cta_url con link+postre) y pasa a postventa_resena', async () => {
    supabaseStub = makeSupabaseStub({
      order_surveys: { onUpdate: () => ({}) },
      settings: { single: { review_gift_name: 'Brownie', review_link: 'http://resena', review_gift_enabled: true, review_gift_expiry_days: 30 } },
    });
    const next = await handlePostventaEncuesta(ctxOf(
      { listReplyId: 'survey_5' },
      { step: 'postventa_encuesta', surveyOrderId: 'o1', customer: { name: 'Ana' } },
    ));
    expect(next.step).toBe('postventa_resena');
    const opts = sendCtaUrlMock.mock.calls[0][0];
    expect(opts.body).toContain('Brownie');
    expect(opts.url).toBe('http://resena');
  });

  it('encuesta rating 2 ⇒ pasa a humano y finaliza', async () => {
    const chatUpdate = vi.fn();
    supabaseStub = makeSupabaseStub({
      order_surveys: { onUpdate: () => ({}) },
      chats: { onUpdate: (p) => { chatUpdate(p); return {}; } },
    });
    const next = await handlePostventaEncuesta(ctxOf(
      { listReplyId: 'survey_2' },
      { step: 'postventa_encuesta', surveyOrderId: 'o1', customer: { name: 'Ana' } },
    ));
    expect(next.step).toBe('finalizado');
    expect(chatUpdate).toHaveBeenCalledWith({ status: 'human' });
    expect(sendTextMock).toHaveBeenCalled();
  });

  it('encuesta rating 3 ⇒ también pasa a humano (umbral 1–3)', async () => {
    const chatUpdate = vi.fn();
    supabaseStub = makeSupabaseStub({
      order_surveys: { onUpdate: () => ({}) },
      chats: { onUpdate: (p) => { chatUpdate(p); return {}; } },
    });
    const next = await handlePostventaEncuesta(ctxOf(
      { listReplyId: 'survey_3' },
      { step: 'postventa_encuesta', surveyOrderId: 'o1' },
    ));
    expect(next.step).toBe('finalizado');
    expect(chatUpdate).toHaveBeenCalledWith({ status: 'human' });
  });

  it('reseña con imagen ⇒ crea reward pendiente y NO traba el chat (sigue en bot)', async () => {
    const rewardInsert = vi.fn();
    const chatUpdateLocal = vi.fn();
    supabaseStub = makeSupabaseStub({
      settings: { single: { review_gift_enabled: true, review_gift_name: 'Brownie' } },
      rewards: { rows: [], onInsert: (p) => { rewardInsert(p); return {}; } },
      chats: { onUpdate: (p) => { chatUpdateLocal(p); return {}; } },
    });
    const next = await handlePostventaResena(ctxOf(
      { image: { url: 'http://shot' } },
      { step: 'postventa_resena', surveyOrderId: 'o1' },
    ));
    expect(next.step).toBe('finalizado');
    expect(rewardInsert).toHaveBeenCalledTimes(1);
    const r = rewardInsert.mock.calls[0][0];
    expect(r.status).toBe('pendiente');
    expect(r.screenshot_url).toBe('http://shot');
    // El chat NO se pasa a 'human': la verificación es asíncrona (panel), el
    // cliente puede seguir escribiendo (p. ej. hacer otro pedido).
    expect(chatUpdateLocal).not.toHaveBeenCalled();
  });

  it('reseña con imagen pero ya hay reward activo ⇒ no duplica', async () => {
    const rewardInsert = vi.fn();
    supabaseStub = makeSupabaseStub({
      settings: { single: { review_gift_enabled: true, review_gift_name: 'Brownie' } },
      rewards: { rows: [{ id: 'rw-activo', phone: '573136913188', status: 'otorgado' }], onInsert: (p) => { rewardInsert(p); return {}; } },
      chats: { onUpdate: () => ({}) },
    });
    const next = await handlePostventaResena(ctxOf(
      { image: { url: 'http://shot' } },
      { step: 'postventa_resena', surveyOrderId: 'o1' },
    ));
    expect(next.step).toBe('finalizado');
    expect(rewardInsert).not.toHaveBeenCalled();
  });

  it('reseña sin imagen ⇒ pide el pantallazo y se queda en postventa_resena', async () => {
    const next = await handlePostventaResena(ctxOf(
      { text: 'ya la dejé' },
      { step: 'postventa_resena', surveyOrderId: 'o1' },
    ));
    expect(next.step).toBe('postventa_resena');
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('pantallazo'));
  });
});

/**
 * Tests del viaje de VUELTA de la degradación.
 *
 * La mitad de ida (renderizar el menú numerado) se prueba en `degrade.test.ts`
 * y en el contract test. Acá se prueba la mitad que todo el mundo olvida: que
 * el "2" que escribe el cliente vuelva a convertirse en `btn_humano` antes de
 * llegar al state machine.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingOptions } from './degrade';

let pending: PendingOptions | null = null;

// `inbound.ts` arrastra el bot (y con él el env global). Estos tests miran la
// lógica de normalización y del par de degradación, así que el resto se mockea.
vi.mock('@/lib/bot/flow', () => ({ processFlowMessage: vi.fn() }));
vi.mock('@/lib/messaging', () => ({ recordMessage: vi.fn(), chatIdFor: (c: string, p: string) => `wa:${c}:${p}` }));
vi.mock('@/lib/db', () => ({ supabaseAdmin: () => ({}) }));

vi.mock('./pending', () => ({
  loadPendingOptions: async () => pending,
  savePendingOptions: async () => {},
  clearPendingOptions: async () => {},
}));

import { envelopeToIncoming, previewFor, resolveDegradedReply } from './inbound';
import type { InboundEnvelope } from './types';

const MENU: PendingOptions = {
  options: [
    { key: '1', id: 'btn_pedir', title: 'Hacer pedido' },
    { key: '2', id: 'btn_humano', title: 'Hablar con alguien' },
  ],
  sentAt: new Date().toISOString(),
};

function textEnvelope(text: string): InboundEnvelope {
  return {
    providerMessageId: 'm1',
    from: '573001234567',
    kind: 'text',
    text,
  };
}

beforeEach(() => {
  pending = null;
});

describe('resolveDegradedReply', () => {
  it('convierte la respuesta numérica en el id del botón original', async () => {
    pending = MENU;
    const { envelope, hadPending } = await resolveDegradedReply(
      textEnvelope('2'),
      'wa:co-1:573001234567',
    );

    expect(hadPending).toBe(true);
    expect(envelope.kind).toBe('interactive');
    expect(envelope.interactiveId).toBe('btn_humano');
    expect(envelope.interactiveTitle).toBe('Hablar con alguien');
  });

  it('deja pasar el texto tal cual si no matchea — el bot decide', async () => {
    pending = MENU;
    const { envelope } = await resolveDegradedReply(
      textEnvelope('quiero una hamburguesa doble'),
      'chat',
    );
    expect(envelope.kind).toBe('text');
    expect(envelope.text).toBe('quiero una hamburguesa doble');
    expect(envelope.interactiveId).toBeUndefined();
  });

  it('no toca nada si no hay menú pendiente', async () => {
    pending = null;
    const { envelope, hadPending } = await resolveDegradedReply(textEnvelope('1'), 'chat');
    expect(hadPending).toBe(false);
    expect(envelope.kind).toBe('text');
  });

  it('ignora un menú vencido: un "1" viejo no reactiva una opción', async () => {
    pending = {
      ...MENU,
      sentAt: new Date(Date.now() - 45 * 60_000).toISOString(), // 45 min
    };
    const { envelope, hadPending } = await resolveDegradedReply(textEnvelope('1'), 'chat');
    expect(hadPending).toBe(true); // hay que limpiarlo
    expect(envelope.kind).toBe('text'); // pero no se interpreta
  });

  it('no intenta mapear mensajes que no son texto', async () => {
    pending = MENU;
    const loc: InboundEnvelope = {
      providerMessageId: 'm2',
      from: '573001234567',
      kind: 'location',
      location: { lat: 6.24, lng: -75.58 },
    };
    const { envelope, hadPending } = await resolveDegradedReply(loc, 'chat');
    expect(hadPending).toBe(false);
    expect(envelope.kind).toBe('location');
  });
});

describe('envelopeToIncoming', () => {
  it('mapea un interactivo a buttonReplyId, que es lo que leen los handlers', () => {
    expect(
      envelopeToIncoming({
        providerMessageId: 'm',
        from: '57300',
        kind: 'interactive',
        interactiveId: 'btn_pedir',
      }),
    ).toMatchObject({ buttonReplyId: 'btn_pedir' });
  });

  it('mapea texto, ubicación e imagen', () => {
    expect(envelopeToIncoming(textEnvelope('hola'))).toMatchObject({ text: 'hola' });
    expect(
      envelopeToIncoming({
        providerMessageId: 'm',
        from: '57300',
        kind: 'location',
        location: { lat: 1, lng: 2 },
      }),
    ).toMatchObject({ location: { lat: 1, lng: 2 } });
    expect(
      envelopeToIncoming({
        providerMessageId: 'm',
        from: '57300',
        kind: 'image',
        image: { url: 'https://x/y.jpg' },
      }),
    ).toMatchObject({ image: { url: 'https://x/y.jpg' } });
  });
});

describe('previewFor', () => {
  it('genera el texto que ve el operario en el panel', () => {
    expect(previewFor(textEnvelope('hola'))).toBe('hola');
    expect(
      previewFor({
        providerMessageId: 'm',
        from: '57300',
        kind: 'interactive',
        interactiveTitle: 'Hacer pedido',
      }),
    ).toBe('Hacer pedido');
    expect(
      previewFor({
        providerMessageId: 'm',
        from: '57300',
        kind: 'location',
        location: { lat: 6.24, lng: -75.58 },
      }),
    ).toContain('📍 ubicación');
    expect(
      previewFor({ providerMessageId: 'm', from: '57300', kind: 'image', image: {} }),
    ).toBe('📷 Imagen');
  });
});

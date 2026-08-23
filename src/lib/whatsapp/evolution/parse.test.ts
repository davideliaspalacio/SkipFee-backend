import { describe, expect, it } from 'vitest';
import { parseConnectionUpdate, parseEvolutionInbound, phoneFromJid } from './parse';

function upsert(data: Record<string, unknown>) {
  return { event: 'messages.upsert', instance: 'test', data };
}

const KEY = { remoteJid: '573001234567@s.whatsapp.net', fromMe: false, id: '3EB0ABC' };

describe('phoneFromJid', () => {
  it('extrae solo dígitos', () => {
    expect(phoneFromJid('573001234567@s.whatsapp.net')).toBe('573001234567');
    expect(phoneFromJid('573001234567:12@s.whatsapp.net')).toBe('573001234567');
  });
});

describe('parseEvolutionInbound', () => {
  it('parsea texto simple (`conversation`)', () => {
    const env = parseEvolutionInbound(
      upsert({ key: KEY, pushName: 'Juan', message: { conversation: 'hola' } }),
    );
    expect(env).toMatchObject({
      providerMessageId: '3EB0ABC',
      from: '573001234567',
      contactName: 'Juan',
      kind: 'text',
      text: 'hola',
    });
  });

  it('parsea texto citado (`extendedTextMessage`) — si no, se perderían', () => {
    const env = parseEvolutionInbound(
      upsert({ key: KEY, message: { extendedTextMessage: { text: 'respondo esto' } } }),
    );
    expect(env).toMatchObject({ kind: 'text', text: 'respondo esto' });
  });

  it('parsea imagen y ubicación', () => {
    const img = parseEvolutionInbound(
      upsert({ key: KEY, message: { imageMessage: { url: 'https://x/y.jpg', caption: 'mira' } } }),
    );
    expect(img).toMatchObject({ kind: 'image', image: { url: 'https://x/y.jpg', caption: 'mira' } });

    const loc = parseEvolutionInbound(
      upsert({
        key: KEY,
        message: { locationMessage: { degreesLatitude: 6.24, degreesLongitude: -75.58 } },
      }),
    );
    expect(loc).toMatchObject({ kind: 'location', location: { lat: 6.24, lng: -75.58 } });
  });

  it('parsea interactivos nativos si el motor los soportó', () => {
    const btn = parseEvolutionInbound(
      upsert({
        key: KEY,
        message: {
          buttonsResponseMessage: {
            selectedButtonId: 'btn_pedir',
            selectedDisplayText: 'Hacer pedido',
          },
        },
      }),
    );
    expect(btn).toMatchObject({
      kind: 'interactive',
      interactiveId: 'btn_pedir',
      interactiveTitle: 'Hacer pedido',
    });
  });

  it('acepta el array que Evolution manda a veces', () => {
    const env = parseEvolutionInbound(
      upsert([{ key: KEY, message: { conversation: 'hola' } }] as never),
    );
    expect(env).toMatchObject({ kind: 'text', text: 'hola' });
  });

  describe('descarta lo que no es un chat 1-a-1 con un cliente', () => {
    it('ignora el eco de nuestros propios envíos (fromMe)', () => {
      expect(
        parseEvolutionInbound(
          upsert({ key: { ...KEY, fromMe: true }, message: { conversation: 'eco' } }),
        ),
      ).toBeNull();
    });

    it('ignora grupos', () => {
      expect(
        parseEvolutionInbound(
          upsert({
            key: { ...KEY, remoteJid: '12345@g.us' },
            message: { conversation: 'grupo' },
          }),
        ),
      ).toBeNull();
    });

    it('ignora estados', () => {
      expect(
        parseEvolutionInbound(
          upsert({
            key: { ...KEY, remoteJid: 'status@broadcast' },
            message: { conversation: 'estado' },
          }),
        ),
      ).toBeNull();
    });

    it('ignora eventos que no son mensajes', () => {
      expect(
        parseEvolutionInbound({ event: 'connection.update', data: { state: 'open' } }),
      ).toBeNull();
    });
  });
});

describe('parseConnectionUpdate', () => {
  it('extrae el estado', () => {
    expect(
      parseConnectionUpdate({ event: 'connection.update', instance: 'x', data: { state: 'open' } }),
    ).toEqual({ state: 'open', instance: 'x' });
  });

  it('devuelve null para otros eventos', () => {
    expect(parseConnectionUpdate({ event: 'messages.upsert', data: {} })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { esLid, parseEvolutionInbound, remitenteDe } from './parse';

/**
 * Los payloads de aquí abajo NO son inventados: salieron de la instancia real
 * (`/chat/findMessages`) el día que el bot dejó de contestar. El primero es el
 * caso bueno —WhatsApp manda el teléfono en `remoteJidAlt`— y el segundo es el
 * que rompía todo: un LID a secas, sin teléfono por ningún lado.
 */

describe('remitente cuando WhatsApp direcciona por LID', () => {
  it('prefiere el teléfono real de remoteJidAlt', () => {
    expect(
      remitenteDe({
        remoteJid: '269578051543282@lid',
        remoteJidAlt: '573013334135@s.whatsapp.net',
        addressingMode: 'lid',
      }),
    ).toEqual({ id: '573013334135', esTelefono: true });
  });

  it('sin alterno, conserva el sufijo @lid y NO lo hace pasar por teléfono', () => {
    // El sufijo es lo que impide que aguas abajo se le pegue `@s.whatsapp.net`
    // y la respuesta se vaya a un destino inexistente.
    expect(
      remitenteDe({ remoteJid: '2602968314104@lid', addressingMode: 'lid' }),
    ).toEqual({ id: '2602968314104@lid', esTelefono: false });
  });

  it('un JID normal sigue funcionando igual que siempre', () => {
    expect(remitenteDe({ remoteJid: '573001234567@s.whatsapp.net' })).toEqual({
      id: '573001234567',
      esTelefono: true,
    });
  });

  it('no cambia un LID por otro LID', () => {
    // Si el alterno también fuera opaco, cambiarlo no gana nada y encima
    // movería la identidad del chat entre mensajes.
    expect(
      remitenteDe({
        remoteJid: '2602968314104@lid',
        remoteJidAlt: '999888777@lid',
        addressingMode: 'lid',
      }),
    ).toEqual({ id: '2602968314104@lid', esTelefono: false });
  });

  it('detecta el sufijo', () => {
    expect(esLid('123@lid')).toBe(true);
    expect(esLid('573001234567@s.whatsapp.net')).toBe(false);
  });
});

describe('el entrante completo', () => {
  const mensaje = (key: Record<string, unknown>) => ({
    event: 'messages.upsert',
    data: {
      key: { id: 'ABC123', fromMe: false, ...key },
      pushName: 'David',
      message: { conversation: 'hola' },
    },
  });

  it('el pedido queda asociado al teléfono, no al LID', () => {
    const env = parseEvolutionInbound(
      mensaje({
        remoteJid: '269578051543282@lid',
        remoteJidAlt: '573013334135@s.whatsapp.net',
        addressingMode: 'lid',
      }),
    );
    expect(env?.from).toBe('573013334135');
    expect(env?.text).toBe('hola');
  });

  it('sin teléfono, no se pierde el mensaje: se atiende con el LID', () => {
    const env = parseEvolutionInbound(
      mensaje({ remoteJid: '2602968314104@lid', addressingMode: 'lid' }),
    );
    expect(env?.from).toBe('2602968314104@lid');
  });

  it('los grupos y los ecos propios se siguen descartando', () => {
    expect(parseEvolutionInbound(mensaje({ remoteJid: '123@g.us' }))).toBeNull();
    expect(
      parseEvolutionInbound({
        event: 'messages.upsert',
        data: {
          key: { id: 'X', fromMe: true, remoteJid: '573001234567@s.whatsapp.net' },
          message: { conversation: 'eco' },
        },
      }),
    ).toBeNull();
  });
});


describe('la respuesta vuelve por donde entró', () => {
  it('a un LID se le contesta como LID, no como teléfono', async () => {
    const { EvolutionClient } = await import('./client');
    // Este es el bug exacto que dejó al bot mudo: Evolution respondía
    // `{"jid":"2602968314104@s.whatsapp.net","exists":false}`.
    expect(EvolutionClient.normalizeNumber('2602968314104@lid')).toBe('2602968314104@lid');
  });

  it('un teléfono se sigue normalizando a solo dígitos', async () => {
    const { EvolutionClient } = await import('./client');
    expect(EvolutionClient.normalizeNumber('+57 301 358 9021')).toBe('573013589021');
    expect(EvolutionClient.normalizeNumber('573013589021@s.whatsapp.net')).toBe('573013589021');
  });
});

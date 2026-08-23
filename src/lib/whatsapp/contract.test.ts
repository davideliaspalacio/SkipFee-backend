/**
 * CONTRACT TEST — la misma suite contra los DOS adaptadores.
 *
 * El objetivo no es probar Kapso ni Evolution por separado, sino que ambos
 * cumplan el mismo contrato: mismas firmas, misma forma de respuesta, y sobre
 * todo que **ninguna llamada interactiva falle por falta de capability**.
 *
 * Si Evolution se desvía del contrato, esto salta en CI y no en producción un
 * viernes a las 8pm.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Kapso SDK: capturamos lo que se le pide -----------------------------
const kapsoCalls: Array<{ method: string; args: unknown }> = [];
vi.mock('@kapso/whatsapp-cloud-api', () => ({
  WhatsAppClient: class {
    messages = {
      sendText: async (a: unknown) => {
        kapsoCalls.push({ method: 'sendText', args: a });
        return { messages: [{ id: 'wamid.KAPSO' }] };
      },
      sendImage: async (a: unknown) => {
        kapsoCalls.push({ method: 'sendImage', args: a });
        return { messages: [{ id: 'wamid.KAPSO' }] };
      },
      sendInteractiveButtons: async (a: unknown) => {
        kapsoCalls.push({ method: 'sendInteractiveButtons', args: a });
        return { messages: [{ id: 'wamid.KAPSO' }] };
      },
      sendInteractiveList: async (a: unknown) => {
        kapsoCalls.push({ method: 'sendInteractiveList', args: a });
        return { messages: [{ id: 'wamid.KAPSO' }] };
      },
      sendInteractiveCtaUrl: async (a: unknown) => {
        kapsoCalls.push({ method: 'sendInteractiveCtaUrl', args: a });
        return { messages: [{ id: 'wamid.KAPSO' }] };
      },
    };
  },
}));

// --- pending_options: capturamos sin tocar BD ----------------------------
const savedPending: Array<{ chatId: string; pending: unknown }> = [];
vi.mock('./pending', () => ({
  savePendingOptions: async (chatId: string, pending: unknown) => {
    savedPending.push({ chatId, pending });
  },
  loadPendingOptions: async () => null,
  clearPendingOptions: async () => {},
}));

import { EvolutionProvider } from './evolution/adapter';
import { KapsoProvider } from './kapso/adapter';
import type { WhatsAppProvider } from './provider';

/** Cuerpos de texto que Evolution recibió por fetch. */
let evolutionSent: Array<{ path: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
  kapsoCalls.length = 0;
  savedPending.length = 0;
  evolutionSent = [];

  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    evolutionSent.push({
      path: new URL(url).pathname,
      body: JSON.parse((init.body as string) ?? '{}'),
    });
    return new Response(JSON.stringify({ key: { id: 'EVO123' } }), { status: 200 });
  });
});

function makeKapso(): WhatsAppProvider {
  return new KapsoProvider({
    companyId: 'co-1',
    apiKey: 'k',
    phoneNumberId: 'pn-1',
    webhookSecret: 'secret',
  });
}

function makeEvolution(): WhatsAppProvider {
  return new EvolutionProvider({
    companyId: 'co-1',
    baseUrl: 'https://evo.test',
    apiKey: 'k',
    instance: 'inst',
    webhookToken: 'tok-abcdefgh',
  });
}

const PROVIDERS: Array<[string, () => WhatsAppProvider]> = [
  ['kapso', makeKapso],
  ['evolution', makeEvolution],
];

describe.each(PROVIDERS)('contrato del puerto — %s', (kind, make) => {
  it('se identifica y declara capabilities completas', () => {
    const p = make();
    expect(p.kind).toBe(kind);
    expect(p.companyId).toBe('co-1');
    for (const cap of ['buttons', 'lists', 'ctaUrl', 'images', 'deliveryStatus', 'session']) {
      expect(typeof p.capabilities[cap as keyof typeof p.capabilities]).toBe('boolean');
    }
  });

  it('sendText devuelve un id de mensaje', async () => {
    const res = await make().sendText({ to: '573001234567', body: 'hola' });
    expect(res.messages?.[0]?.id).toBeTruthy();
  });

  it('sendImage devuelve un id de mensaje', async () => {
    const res = await make().sendImage({
      to: '573001234567',
      link: 'https://x/y.jpg',
      caption: 'foto',
    });
    expect(res.messages?.[0]?.id).toBeTruthy();
  });

  /**
   * El punto central del contrato: los interactivos SIEMPRE funcionan. Si el
   * proveedor no los soporta nativamente, degrada — nunca lanza.
   */
  it('sendButtons nunca falla, soporte nativo o no', async () => {
    const res = await make().sendButtons({
      to: '573001234567',
      body: '¿Qué quieres hacer?',
      buttons: [
        { id: 'btn_pedir', title: 'Hacer pedido' },
        { id: 'btn_humano', title: 'Hablar con alguien' },
      ],
    });
    expect(res.messages?.[0]?.id).toBeTruthy();
  });

  it('sendList nunca falla, soporte nativo o no', async () => {
    const res = await make().sendList({
      to: '573001234567',
      body: 'Elige',
      buttonText: 'Ver opciones',
      sections: [{ title: 'Combos', rows: [{ id: 'c1', title: 'Sub de pollo' }] }],
    });
    expect(res.messages?.[0]?.id).toBeTruthy();
  });

  it('sendCtaUrl nunca falla, soporte nativo o no', async () => {
    const res = await make().sendCtaUrl({
      to: '573001234567',
      body: 'Listo para pagar',
      displayText: 'Abrir tienda',
      url: 'https://tienda.skipfee.co/pedir?orderId=abc',
    });
    expect(res.messages?.[0]?.id).toBeTruthy();
  });

  it('parseInbound devuelve null ante basura, sin lanzar', () => {
    expect(make().parseInbound({ nada: true })).toBeNull();
  });

  it('verifyWebhook rechaza una petición sin credenciales', () => {
    expect(
      make().verifyWebhook({ rawBody: '{}', headers: new Headers() }),
    ).toBe(false);
  });
});

// =========================================================================
// Diferencias ESPERADAS entre proveedores
// =========================================================================

describe('Kapso usa los interactivos nativos', () => {
  it('manda botones como interactive, no como texto', async () => {
    await makeKapso().sendButtons({
      to: '57300',
      body: 'x',
      buttons: [{ id: 'a', title: 'A' }],
    });
    expect(kapsoCalls.map(c => c.method)).toContain('sendInteractiveButtons');
    expect(savedPending).toHaveLength(0); // no degrada → no hay nada que mapear
  });
});

describe('Evolution degrada a texto numerado', () => {
  it('convierte botones en un menú y guarda el mapeo de vuelta', async () => {
    await makeEvolution().sendButtons({
      to: '573001234567',
      body: '¿Qué quieres hacer?',
      buttons: [
        { id: 'btn_pedir', title: 'Hacer pedido' },
        { id: 'btn_humano', title: 'Hablar con alguien' },
      ],
    });

    // Salió como texto plano por sendText
    expect(evolutionSent[0].path).toBe('/message/sendText/inst');
    const text = evolutionSent[0].body.text as string;
    expect(text).toContain('1️⃣ Hacer pedido');
    expect(text).toContain('2️⃣ Hablar con alguien');

    // Y se guardó el mapeo — sin esto el bot no entendería la respuesta
    expect(savedPending).toHaveLength(1);
    expect(savedPending[0].chatId).toBe('wa:co-1:573001234567');
    expect((savedPending[0].pending as { options: unknown[] }).options).toEqual([
      { key: '1', id: 'btn_pedir', title: 'Hacer pedido' },
      { key: '2', id: 'btn_humano', title: 'Hablar con alguien' },
    ]);
  });

  it('aplana las listas y también guarda el mapeo', async () => {
    await makeEvolution().sendList({
      to: '573001234567',
      body: 'Elige',
      buttonText: 'Ver',
      sections: [
        { title: 'Combos', rows: [{ id: 'c1', title: 'Sub de pollo' }] },
        { rows: [{ id: 'b1', title: 'Bebida' }] },
      ],
    });
    const opts = (savedPending[0].pending as { options: Array<{ id: string }> }).options;
    expect(opts.map(o => o.id)).toEqual(['c1', 'b1']);
  });

  it('el CTA mete el link en el cuerpo y NO deja opciones pendientes', async () => {
    await makeEvolution().sendCtaUrl({
      to: '573001234567',
      body: 'Listo para pagar',
      displayText: 'Abrir tienda',
      url: 'https://tienda.skipfee.co/pedir?orderId=abc',
    });
    expect(evolutionSent[0].body.text).toContain('https://tienda.skipfee.co/pedir?orderId=abc');
    expect(savedPending).toHaveLength(0);
  });

  it('normaliza el número al formato que espera Evolution', async () => {
    await makeEvolution().sendText({ to: '+57 300 123 4567', body: 'hola' });
    expect(evolutionSent[0].body.number).toBe('573001234567');
  });

  it('verifyWebhook acepta el token compartido', () => {
    const p = makeEvolution();
    expect(
      p.verifyWebhook({
        rawBody: '{}',
        headers: new Headers({ 'x-evolution-token': 'tok-abcdefgh' }),
      }),
    ).toBe(true);
    expect(
      p.verifyWebhook({
        rawBody: '{}',
        headers: new Headers({ 'x-evolution-token': 'tok-WRONGXXX' }),
      }),
    ).toBe(false);
  });
});

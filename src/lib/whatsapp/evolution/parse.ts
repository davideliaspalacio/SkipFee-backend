/**
 * Parseo del webhook de Evolution API → `InboundEnvelope`.
 *
 * Evolution manda el shape crudo de Baileys, bastante distinto al de Kapso:
 *
 *   {
 *     "event": "messages.upsert",
 *     "instance": "bros-and-subs",
 *     "data": {
 *       "key": { "remoteJid": "573001234567@s.whatsapp.net",
 *                "fromMe": false, "id": "3EB0..." },
 *       "pushName": "Juan",
 *       "message": { "conversation": "hola" },
 *       "messageType": "conversation"
 *     }
 *   }
 *
 * El texto puede venir en `conversation` (mensaje simple) o en
 * `extendedTextMessage.text` (respuesta/citado). Hay que cubrir ambos o los
 * mensajes que citan a otro se pierden en silencio.
 */

import { z } from 'zod';
import type { InboundEnvelope, SessionStatus } from '../types';

const dataSchema = z
  .object({
    key: z
      .object({
        id: z.string().optional(),
        remoteJid: z.string().optional(),
        /** El teléfono real cuando `remoteJid` viene como LID. Ver `remitenteDe`. */
        remoteJidAlt: z.string().optional(),
        addressingMode: z.string().optional(),
        fromMe: z.boolean().optional(),
      })
      .passthrough(),
    pushName: z.string().nullable().optional(),
    messageType: z.string().optional(),
    message: z
      .object({
        conversation: z.string().optional(),
        extendedTextMessage: z.object({ text: z.string().optional() }).passthrough().optional(),
        imageMessage: z
          .object({ url: z.string().optional(), caption: z.string().optional() })
          .passthrough()
          .optional(),
        locationMessage: z
          .object({
            degreesLatitude: z.number().optional(),
            degreesLongitude: z.number().optional(),
          })
          .passthrough()
          .optional(),
        // Por si el motor SÍ soporta interactivos (GOWS/WEBJS a veces).
        buttonsResponseMessage: z
          .object({
            selectedButtonId: z.string().optional(),
            selectedDisplayText: z.string().optional(),
          })
          .passthrough()
          .optional(),
        listResponseMessage: z
          .object({
            title: z.string().optional(),
            singleSelectReply: z
              .object({ selectedRowId: z.string().optional() })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const payloadSchema = z
  .object({
    event: z.string().optional(),
    instance: z.string().optional(),
    data: z.union([dataSchema, z.array(dataSchema)]).optional(),
  })
  .passthrough();

/** Extrae el teléfono del JID: "573001234567@s.whatsapp.net" → "573001234567". */
export function phoneFromJid(jid: string): string {
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

/** ¿Este JID es un LID y no un teléfono? */
export function esLid(jid: string): boolean {
  return jid.endsWith('@lid');
}

/**
 * Quién escribió, en teléfono de verdad cuando se puede saber.
 *
 * WhatsApp dejó de entregar siempre el número: desde el direccionamiento por
 * **LID**, el `remoteJid` puede venir como `2602968314104@lid`, un identificador
 * interno que NO es un teléfono. Guardarlo como si lo fuera es lo que rompe el
 * resto del sistema aguas abajo — `customers.phone` es único y es por donde se
 * reconoce a un cliente que vuelve, y las notificaciones del pedido salen hacia
 * ese número. Con un LID ahí, el cliente se duplica en cada visita y los avisos
 * de "tu pedido va en camino" se van a un destino que no existe.
 *
 * Cuando el mensaje viene por LID, WhatsApp manda el teléfono aparte en
 * `remoteJidAlt`. Se prefiere ese.
 *
 * Si no viene —pasa, y no hay forma de resolverlo desde el webhook— se usa el
 * LID como identidad. Es lo menos malo: la conversación sigue coherente y las
 * respuestas llegan igual, porque se contesta al mismo JID. Lo que no se puede
 * es fingir que eso es un teléfono, así que se devuelve marcado.
 */
export function remitenteDe(key: {
  remoteJid?: string;
  remoteJidAlt?: string;
  addressingMode?: string;
}): { id: string; esTelefono: boolean } {
  const jid = key.remoteJid ?? '';
  const porLid = key.addressingMode === 'lid' || esLid(jid);

  if (porLid) {
    const alt = key.remoteJidAlt ?? '';
    // El alterno solo sirve si de verdad es un teléfono; si viniera otro LID,
    // preferir el original antes que cambiar un identificador opaco por otro.
    if (alt && !esLid(alt)) {
      const telefono = phoneFromJid(alt);
      if (telefono) return { id: telefono, esTelefono: true };
    }
    // Se devuelve CON el sufijo `@lid` a propósito. El identificador tiene que
    // llevar puesto qué tipo de cosa es: si se guarda pelado, más adelante
    // alguien lo trata como teléfono —y el envío termina en
    // `<lid>@s.whatsapp.net`, que no existe— o peor, queda en `customers.phone`
    // pareciendo un número de verdad. Que se vea raro es la gracia.
    const lid = jid.split(':')[0];
    return { id: lid.endsWith('@lid') ? lid : `${phoneFromJid(jid)}@lid`, esTelefono: false };
  }

  return { id: phoneFromJid(jid), esTelefono: true };
}

/** Eventos de mensaje entrante que nos interesan. */
const MESSAGE_EVENTS = new Set(['messages.upsert', 'MESSAGES_UPSERT']);

export function parseEvolutionInbound(payload: unknown): InboundEnvelope | null {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    console.warn('[evolution parse] payload no matchea schema', {
      issues: parsed.error.issues,
    });
    return null;
  }

  const { event, data } = parsed.data;

  // Solo mensajes entrantes. `connection.update` y los acuses se manejan aparte.
  if (event && !MESSAGE_EVENTS.has(event)) return null;
  if (!data) return null;

  // Evolution a veces manda un array de mensajes en un solo webhook.
  const item = Array.isArray(data) ? data[0] : data;
  if (!item) return null;

  const jid = item.key.remoteJid ?? '';

  // Descartar lo que no es un chat 1-a-1 con un cliente:
  //  - fromMe: eco de nuestros propios envíos
  //  - @g.us: grupos
  //  - status@broadcast: estados
  if (item.key.fromMe) return null;
  if (jid.endsWith('@g.us')) return null;
  if (jid.startsWith('status@')) return null;
  if (!jid) return null;

  const remitente = remitenteDe(item.key);
  const from = remitente.id;
  if (!from) return null;

  if (!remitente.esTelefono) {
    // Se sigue adelante: contestar funciona igual. Pero queda dicho en el log,
    // porque el pedido que salga de este chat va a llevar un identificador
    // interno donde debería ir un teléfono.
    console.warn('[evolution parse] entrante por LID sin teléfono asociado', { jid });
  }

  const base = {
    providerMessageId: item.key.id ?? `${jid}:${Date.now()}`,
    from,
    contactName: item.pushName ?? undefined,
    rawType: item.messageType,
  };

  const msg = item.message;
  if (!msg) return { ...base, kind: 'other' };

  // Interactivos: solo si el motor los soportó de verdad.
  const btnId = msg.buttonsResponseMessage?.selectedButtonId;
  if (btnId) {
    return {
      ...base,
      kind: 'interactive',
      interactiveId: btnId,
      interactiveTitle: msg.buttonsResponseMessage?.selectedDisplayText,
    };
  }
  const rowId = msg.listResponseMessage?.singleSelectReply?.selectedRowId;
  if (rowId) {
    return {
      ...base,
      kind: 'interactive',
      interactiveId: rowId,
      interactiveTitle: msg.listResponseMessage?.title,
    };
  }

  // Texto: `conversation` (simple) o `extendedTextMessage.text` (citado).
  const text = msg.conversation ?? msg.extendedTextMessage?.text;
  if (text) return { ...base, kind: 'text', text };

  if (msg.imageMessage) {
    return {
      ...base,
      kind: 'image',
      image: {
        url: msg.imageMessage.url,
        caption: msg.imageMessage.caption,
      },
    };
  }

  if (msg.locationMessage) {
    return {
      ...base,
      kind: 'location',
      location: {
        lat: msg.locationMessage.degreesLatitude ?? 0,
        lng: msg.locationMessage.degreesLongitude ?? 0,
      },
    };
  }

  return { ...base, kind: 'other' };
}

/** Extrae el estado de conexión de un evento `connection.update`. */
export function parseConnectionUpdate(
  payload: unknown,
): { state: string; instance?: string } | null {
  const p = payload as { event?: string; instance?: string; data?: { state?: string } };
  if (!p?.event) return null;
  if (p.event !== 'connection.update' && p.event !== 'CONNECTION_UPDATE') return null;
  const state = p.data?.state;
  if (!state) return null;
  return { state, instance: p.instance };
}

/**
 * Traduce el estado que reporta Evolution al vocabulario del puerto.
 *
 * Acepta también nuestro propio vocabulario porque la columna
 * `evolution_session_state` se escribe desde dos sitios —el webhook, con el
 * crudo de Evolution ('open'), y las rutas de sesión, con el ya traducido
 * ('connected')—. Si la traducción no fuera idempotente, comparar lo guardado
 * con lo que responde el proveedor daría siempre "cambió" y escribiríamos en
 * cada sondeo.
 */
export function mapEvolutionState(raw: string | null | undefined): SessionStatus {
  switch (raw) {
    case 'open':
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    case 'close':
    case 'closed':
    case 'disconnected':
      return 'disconnected';
    default:
      return 'unknown';
  }
}

/** ¿El estado guardado significa que el número está atendiendo? */
export function evolutionSesionConectada(state: string | null | undefined): boolean {
  return mapEvolutionState(state) === 'connected';
}

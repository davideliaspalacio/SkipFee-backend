/**
 * Manejo COMPARTIDO de mensajes entrantes, agnóstico de proveedor.
 *
 * Cada adaptador traduce el payload de su webhook a un `InboundEnvelope`; de
 * aquí hacia abajo el código es el mismo para Kapso y para Evolution.
 *
 * Responsabilidades, en orden:
 *   1. Persistir el mensaje para el panel.
 *   2. Cerrar el par de la DEGRADACIÓN: si el cliente respondió "2" a un menú
 *      de texto numerado, convertirlo de vuelta en el id del botón original.
 *   3. Despachar al state machine del bot si el chat está en modo bot.
 */

import { recordMessage } from '@/lib/messaging';
import { supabaseAdmin } from '@/lib/db';
import { processFlowMessage } from '@/lib/bot/flow';
import type { IncomingMessage } from '@/lib/bot/flow/parser';
import { avisarSiFiltroActivo, numeroPermitido } from './allowlist';
import { matchPendingOption } from './degrade';
import { clearPendingOptions, loadPendingOptions } from './pending';
import type { InboundEnvelope } from './types';

/**
 * Ventana de validez de un menú degradado. Pasado este tiempo, un "1" suelto ya
 * no se interpreta como la opción 1 de un menú viejo — es más probable que el
 * cliente esté escribiendo otra cosa (una cantidad, una dirección).
 */
const PENDING_TTL_MS = 30 * 60_000;

/** Texto que se guarda en `messages.body` y se muestra en el panel. */
export function previewFor(envelope: InboundEnvelope): string {
  switch (envelope.kind) {
    case 'text':
      return envelope.text ?? '[texto vacío]';
    case 'interactive':
      return envelope.interactiveTitle ?? '[interactivo]';
    case 'location': {
      const { lat, lng } = envelope.location ?? { lat: 0, lng: 0 };
      return `📍 ubicación ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }
    case 'image':
      return envelope.image?.caption || '📷 Imagen';
    default:
      return `[${envelope.rawType ?? 'desconocido'}]`;
  }
}

/** `InboundEnvelope` → el shape que consumen los handlers del flow. */
export function envelopeToIncoming(envelope: InboundEnvelope): IncomingMessage {
  const result: IncomingMessage = { rawType: envelope.rawType };

  switch (envelope.kind) {
    case 'text':
      result.text = envelope.text;
      break;
    case 'interactive':
      // El state machine distingue botón de lista, pero los handlers tratan
      // ambos igual (buscan el id). Lo mandamos como buttonReplyId, que es lo
      // que consultan primero.
      result.buttonReplyId = envelope.interactiveId;
      break;
    case 'location':
      result.location = envelope.location;
      break;
    case 'image':
      result.image = envelope.image;
      break;
  }

  return result;
}

/**
 * Cierra el par de la degradación.
 *
 * Si el mensaje es texto y hay un menú numerado vigente para ese chat, traduce
 * la respuesta del cliente al id de la opción original. Sin esto, el proveedor
 * degradado manda menús que el bot nunca entiende y el flujo se rompe.
 *
 * Devuelve el envelope (posiblemente reescrito) y si había opciones que limpiar.
 */
export async function resolveDegradedReply(
  envelope: InboundEnvelope,
  chatId: string,
): Promise<{ envelope: InboundEnvelope; hadPending: boolean }> {
  // Solo el texto plano puede ser respuesta a un menú degradado.
  if (envelope.kind !== 'text') return { envelope, hadPending: false };

  const pending = await loadPendingOptions(chatId);
  if (!pending) return { envelope, hadPending: false };

  // Menú vencido: se descarta sin intentar interpretarlo.
  const age = Date.now() - new Date(pending.sentAt).getTime();
  if (Number.isFinite(age) && age > PENDING_TTL_MS) {
    return { envelope, hadPending: true };
  }

  const id = matchPendingOption(envelope.text, pending);
  if (!id) {
    // No matcheó: dejamos pasar el texto tal cual. El bot decidirá (keyword
    // global, intención de pedir, o fallback de Gemini). No forzamos un match.
    return { envelope, hadPending: true };
  }

  const option = pending.options.find(o => o.id === id);
  return {
    envelope: {
      ...envelope,
      kind: 'interactive',
      interactiveId: id,
      interactiveTitle: option?.title,
    },
    hadPending: true,
  };
}

/**
 * Punto de entrada compartido para cualquier mensaje entrante ya normalizado.
 *
 * Nota sobre durabilidad: el bot se despacha fire-and-forget, igual que antes.
 * Eso significa que un reinicio del proceso pierde los mensajes en vuelo. Es
 * deuda conocida y precede a este cambio; la solución es una cola (pgmq) y está
 * fuera del alcance de esta tarea.
 */
export async function handleInboundMessage(
  envelope: InboundEnvelope,
  companyId?: string,
): Promise<void> {
  const contactName = envelope.contactName ?? envelope.from;

  // 1. Persistir el entrante
  const { chatId } = await recordMessage({
    phone: envelope.from,
    direction: 'in',
    body: previewFor(envelope),
    kapsoMessageId: envelope.providerMessageId,
    name: contactName,
    mediaUrl: envelope.kind === 'image' ? envelope.image?.url ?? null : null,
    companyId,
  });

  // 2. Cerrar el par de la degradación (proveedores sin botones nativos)
  const { envelope: effective, hadPending } = await resolveDegradedReply(
    envelope,
    chatId,
  );
  // El menú se consume una sola vez, matchee o no: si no limpiáramos, un "1"
  // escrito tres pasos después reactivaría una opción vieja.
  if (hadPending) await clearPendingOptions(chatId);

  // 3. Lista blanca de desarrollo: el mensaje YA quedó guardado y se ve en el
  //    panel, pero no se despacha el bot. Se corta aquí y no solo en el envío
  //    para no gastar Gemini ni mover el `flow_state` de un cliente real por un
  //    mensaje que nadie va a contestar automáticamente.
  avisarSiFiltroActivo();
  if (!numeroPermitido(envelope.from)) {
    console.warn(`[bot] ${envelope.from} fuera de WHATSAPP_ALLOWLIST: guardado, sin respuesta`);
    return;
  }

  // 4. ¿El chat está en modo bot?
  let chatQuery = supabaseAdmin().from('chats').select('status').eq('id', chatId);
  if (companyId) chatQuery = chatQuery.eq('company_id', companyId);
  const { data: chat } = await chatQuery.single();
  if (chat?.status !== 'bot') return;

  const botOpts = {
    chatId,
    phone: envelope.from,
    contactName,
    message: envelopeToIncoming(effective),
    companyId,
  };

  void processFlowMessage(botOpts).catch(async err => {
    console.error('[bot] error en processFlowMessage', { chatId, err });
    const { manejarErrorInesperado } = await import('@/lib/bot/flow/handlers');
    await manejarErrorInesperado({ chatId, phone: envelope.from });
  });
}

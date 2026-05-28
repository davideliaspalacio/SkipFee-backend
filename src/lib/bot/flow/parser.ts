/**
 * Normaliza el payload de Kapso (`whatsapp.message.received`) al shape
 * `IncomingMessage` que consumen los handlers del flow.
 */

export interface IncomingMessage {
  /** Texto del mensaje (si type='text'). */
  text?: string;
  /** ID del botón de reply si el cliente clickeó uno. */
  buttonReplyId?: string;
  /** ID de la fila seleccionada si fue list reply. */
  listReplyId?: string;
  /** Ubicación compartida (type='location'). */
  location?: { lat: number; lng: number };
  /** Tipo original reportado por Kapso (para debugging). */
  rawType?: string;
}

interface KapsoMessage {
  type?: string;
  text?: { body?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  location?: { latitude?: number; longitude?: number };
}

export function parseIncoming(message: KapsoMessage): IncomingMessage {
  const result: IncomingMessage = { rawType: message.type };

  if (message.type === 'text' && message.text?.body) {
    result.text = message.text.body;
    return result;
  }

  if (message.type === 'interactive') {
    if (message.interactive?.button_reply?.id) {
      result.buttonReplyId = message.interactive.button_reply.id;
    } else if (message.interactive?.list_reply?.id) {
      result.listReplyId = message.interactive.list_reply.id;
    }
    return result;
  }

  if (message.type === 'location' && message.location) {
    result.location = {
      lat: message.location.latitude ?? 0,
      lng: message.location.longitude ?? 0,
    };
    return result;
  }

  return result;
}

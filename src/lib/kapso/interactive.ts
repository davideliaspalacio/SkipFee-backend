import { kapso } from './client';
import { env } from '@/lib/env';

/**
 * Helpers tipados para enviar mensajes interactivos vía Kapso.
 * Cada función abstrae phoneNumberId (de env) para que el llamador
 * solo se preocupe por destinatario + contenido.
 */

export interface ReplyButton {
  id: string;        // único, lo recibimos en el reply
  title: string;     // texto visible (max 20 chars en WhatsApp)
}

export interface ListSection {
  title?: string;
  rows: Array<{
    id: string;
    title: string;
    description?: string;
  }>;
}

export type InteractiveHeader =
  | { type: 'text'; text: string }
  | { type: 'image'; imageUrl: string }
  | { type: 'video'; videoUrl: string };

function buildHeader(header?: InteractiveHeader) {
  if (!header) return undefined;
  if (header.type === 'text') return { type: 'text' as const, text: header.text };
  if (header.type === 'image') return { type: 'image' as const, image: { link: header.imageUrl } };
  if (header.type === 'video') return { type: 'video' as const, video: { link: header.videoUrl } };
  return undefined;
}

/**
 * Mensaje con hasta 3 botones de reply. Ideal para Sí/No, opciones cortas.
 * WhatsApp limita: titles a 20 chars, body a 1024 chars.
 * Header puede ser texto, imagen o video (en URL pública).
 */
export function sendButtons(opts: {
  to: string;
  body: string;
  buttons: ReplyButton[];
  footer?: string;
  header?: InteractiveHeader;
}) {
  return kapso.messages.sendInteractiveButtons({
    phoneNumberId: env.KAPSO_PHONE_NUMBER_ID,
    to: opts.to,
    bodyText: opts.body,
    buttons: opts.buttons,
    footerText: opts.footer,
    header: buildHeader(opts.header),
  });
}

/**
 * Mensaje de lista con secciones. Total de filas ≤ 10.
 * Útil para la carta (categorías + items).
 */
export function sendList(opts: {
  to: string;
  body: string;
  buttonText: string;   // texto del botón que abre la lista (ej. "Ver carta")
  sections: ListSection[];
  header?: string;
  footer?: string;
}) {
  return kapso.messages.sendInteractiveList({
    phoneNumberId: env.KAPSO_PHONE_NUMBER_ID,
    to: opts.to,
    bodyText: opts.body,
    buttonText: opts.buttonText,
    sections: opts.sections,
    header: opts.header ? { type: 'text', text: opts.header } : undefined,
    footerText: opts.footer,
  });
}

/**
 * Botón con link externo (URL). Ideal para el link de Wompi.
 */
export function sendCtaUrl(opts: {
  to: string;
  body: string;
  displayText: string;  // texto del botón (max 20 chars)
  url: string;
  header?: string;
  footer?: string;
}) {
  return kapso.messages.sendInteractiveCtaUrl({
    phoneNumberId: env.KAPSO_PHONE_NUMBER_ID,
    to: opts.to,
    bodyText: opts.body,
    parameters: {
      displayText: opts.displayText,
      url: opts.url,
    },
    header: opts.header ? { type: 'text', text: opts.header } : undefined,
    footerText: opts.footer,
  });
}

/**
 * Solicita ubicación nativa de WhatsApp.
 * El cliente verá un botón que abre el selector de ubicación.
 */
export function sendLocationRequest(opts: {
  to: string;
  body: string;
  requestText?: string; // texto del botón (default "Compartir ubicación")
  footer?: string;
}) {
  return kapso.messages.sendInteractiveLocationRequest({
    phoneNumberId: env.KAPSO_PHONE_NUMBER_ID,
    to: opts.to,
    bodyText: opts.body,
    parameters: { requestMessage: opts.requestText ?? 'Compartir ubicación' },
    footerText: opts.footer,
  });
}

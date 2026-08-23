/**
 * Parseo del payload `whatsapp.message.received` de Kapso → `InboundEnvelope`.
 *
 * Extraído de `lib/kapso/handlers/message-received.ts`, que mezclaba parseo con
 * persistencia. Ahora cada proveedor parsea lo suyo y todo lo de aguas abajo
 * (persistir, resolver chat, despachar bot) es compartido y agnóstico.
 */

import { z } from 'zod';
import type { InboundEnvelope } from '../types';

const payloadSchema = z
  .object({
    message: z
      .object({
        id: z.string(),
        from: z.string(),
        type: z.string().optional(),
        text: z.object({ body: z.string().optional() }).optional(),
        interactive: z
          .object({
            type: z.string().optional(),
            button_reply: z
              .object({ id: z.string().optional(), title: z.string().optional() })
              .optional(),
            list_reply: z
              .object({ id: z.string().optional(), title: z.string().optional() })
              .optional(),
          })
          .optional(),
        location: z
          .object({ latitude: z.number().optional(), longitude: z.number().optional() })
          .optional(),
        image: z
          .object({
            id: z.string().optional(),
            link: z.string().optional(),
            url: z.string().optional(),
            caption: z.string().optional(),
            mime_type: z.string().optional(),
          })
          .optional(),
        timestamp: z.union([z.string(), z.number()]).optional(),
      })
      .passthrough(),
    conversation: z
      .object({
        contact_name: z.string().nullable().optional(),
        phone_number: z.string().optional(),
      })
      .passthrough()
      .optional(),
    is_new_conversation: z.boolean().optional(),
  })
  .passthrough();

export function parseKapsoInbound(payload: unknown): InboundEnvelope | null {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    console.warn('[kapso parse] payload no matchea schema', {
      issues: parsed.error.issues,
    });
    return null;
  }

  const { message, conversation } = parsed.data;
  const base = {
    providerMessageId: message.id,
    from: message.from,
    contactName: conversation?.contact_name ?? undefined,
    rawType: message.type,
  };

  if (message.type === 'text' && message.text?.body) {
    return { ...base, kind: 'text', text: message.text.body };
  }

  if (message.type === 'interactive') {
    const btn = message.interactive?.button_reply;
    const list = message.interactive?.list_reply;
    const id = btn?.id ?? list?.id;
    const title = btn?.title ?? list?.title;
    return {
      ...base,
      kind: 'interactive',
      interactiveId: id,
      interactiveTitle: title,
    };
  }

  if (message.type === 'location' && message.location) {
    return {
      ...base,
      kind: 'location',
      location: {
        lat: message.location.latitude ?? 0,
        lng: message.location.longitude ?? 0,
      },
    };
  }

  if (message.type === 'image' && message.image) {
    return {
      ...base,
      kind: 'image',
      image: {
        id: message.image.id,
        url: message.image.link ?? message.image.url,
        caption: message.image.caption,
      },
    };
  }

  return { ...base, kind: 'other' };
}

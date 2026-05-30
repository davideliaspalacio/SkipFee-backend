import { z } from 'zod';
import { recordMessage } from '@/lib/messaging';
import { supabaseAdmin } from '@/lib/db';
import { processFlowMessage } from '@/lib/bot/flow';
import { parseIncoming } from '@/lib/bot/flow/parser';

/**
 * Schema del payload `whatsapp.message.received` de Kapso (shape v2).
 */
const payloadSchema = z
  .object({
    message: z
      .object({
        id: z.string(),
        from: z.string(),
        type: z.string().optional(),
        text: z
          .object({
            body: z.string().optional(),
          })
          .optional(),
        interactive: z
          .object({
            type: z.string().optional(),
            button_reply: z.object({ id: z.string().optional(), title: z.string().optional() }).optional(),
            list_reply: z.object({ id: z.string().optional(), title: z.string().optional() }).optional(),
          })
          .optional(),
        location: z
          .object({
            latitude: z.number().optional(),
            longitude: z.number().optional(),
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

export async function handleMessageReceived(payload: unknown): Promise<void> {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    console.warn('[message-received] payload no matchea schema', {
      issues: parsed.error.issues,
      payload,
    });
    return;
  }

  const { message, conversation } = parsed.data;
  const phone = message.from;
  const contactName = conversation?.contact_name ?? phone;

  // Texto que persistimos para el panel.
  const persistedBody = (() => {
    if (message.type === 'text') return message.text?.body ?? '[texto vacío]';
    if (message.type === 'interactive') {
      const btnTitle = message.interactive?.button_reply?.title;
      const listTitle = message.interactive?.list_reply?.title;
      return btnTitle ?? listTitle ?? '[interactivo]';
    }
    if (message.type === 'location') {
      const lat = message.location?.latitude;
      const lng = message.location?.longitude;
      return `📍 ubicación ${lat?.toFixed(5)}, ${lng?.toFixed(5)}`;
    }
    return `[${message.type ?? 'desconocido'}]`;
  })();

  // 1. Persistir el mensaje entrante
  const { chatId } = await recordMessage({
    phone,
    direction: 'in',
    body: persistedBody,
    kapsoMessageId: message.id,
    name: contactName,
  });

  // 2. Si chat está en modo bot, procesar con el state machine (fire-and-forget)
  const { data: chat } = await supabaseAdmin()
    .from('chats')
    .select('status')
    .eq('id', chatId)
    .single();

  if (chat?.status === 'bot') {
    const incoming = parseIncoming(message);
    // Fire-and-forget: el webhook ya devolvió 200 a Kapso. Si el flujo del
    // bot falla, escalamos a humano automáticamente para que el cliente
    // no quede colgado sin respuesta y la operaria tenga contexto.
    void processFlowMessage({ chatId, phone, contactName, message: incoming }).catch(async err => {
      console.error('[bot] error en processFlowMessage', { chatId, err });
      const { manejarErrorInesperado } = await import('@/lib/bot/flow/handlers');
      await manejarErrorInesperado({ chatId, phone });
    });
  }
}

import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';

/**
 * Schema permisivo de eventos de status (delivered / read / sent / failed).
 * Acepta dos shapes posibles porque aún no confirmamos el formato real:
 *   - Wrapper anidado: { message: { id, ... } } (como message.received)
 *   - Plano: { messageId | id, status, ... }
 *
 * Cuando llegue un payload real, simplificamos.
 */
const payloadSchema = z
  .object({
    // Shape anidado (como message.received de Kapso v2)
    message: z
      .object({
        id: z.string().optional(),
      })
      .passthrough()
      .optional(),
    // Shape plano (fallback)
    messageId: z.string().optional(),
    id: z.string().optional(),
    status: z.string().optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export async function handleMessageStatus(opts: {
  event: string;
  payload: unknown;
}): Promise<void> {
  const parsed = payloadSchema.safeParse(opts.payload);
  if (!parsed.success) {
    console.warn('[message-status] payload no matchea schema', {
      issues: parsed.error.issues,
      payload: opts.payload,
    });
    return;
  }

  const kapsoMessageId =
    parsed.data.message?.id ?? parsed.data.messageId ?? parsed.data.id;
  if (!kapsoMessageId) {
    console.warn('[message-status] sin id, no podemos correlacionar', opts.payload);
    return;
  }

  // El evento determina el campo a actualizar.
  const update: Record<string, string> = {};
  if (opts.event === 'whatsapp.message.delivered') {
    update.delivered_at = new Date().toISOString();
  } else if (opts.event === 'whatsapp.message.read') {
    update.read_at = new Date().toISOString();
  } else {
    // sent / failed → solo log por ahora
    console.log('[message-status] no-op', { event: opts.event, kapsoMessageId });
    return;
  }

  const sb = supabaseAdmin();
  const { error } = await sb
    .from('messages')
    .update(update)
    .eq('kapso_message_id', kapsoMessageId);
  if (error) throw error;
}

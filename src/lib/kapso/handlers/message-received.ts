/**
 * Handler de `whatsapp.message.received` de Kapso.
 *
 * Tras la introducción del puerto multi-proveedor este archivo quedó fino a
 * propósito: parsea el payload de Kapso a `InboundEnvelope` y delega en el
 * manejo COMPARTIDO (`lib/whatsapp/inbound.ts`), que es el mismo que usa
 * Evolution. Antes mezclaba parseo con persistencia y despacho del bot.
 *
 * Se conserva la ruta de import original para no romper callers existentes.
 */

import { parseKapsoInbound } from '@/lib/whatsapp/kapso/parse';
import { handleInboundMessage } from '@/lib/whatsapp/inbound';

export async function handleMessageReceived(
  payload: unknown,
  /** Empresa que recibe el webhook (multi-empresa). */
  companyId?: string,
): Promise<void> {
  const envelope = parseKapsoInbound(payload);
  if (!envelope) return;
  await handleInboundMessage(envelope, companyId);
}

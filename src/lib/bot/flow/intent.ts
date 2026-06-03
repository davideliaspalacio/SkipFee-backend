/**
 * Detección de la intención de "pedir" en el bot mínimo.
 *
 * En el flujo nuevo el bot no maneja carta/carrito/pago: cuando el cliente
 * quiere pedir, le mandamos el link a la tienda web. Esta función reconoce esa
 * intención desde texto libre en CUALQUIER step, incluido el texto exacto que
 * pre-rellena el botón de "carrito vencido" de la tienda (`"Quiero hacer un
 * pedido"`, ver CONTRACT/PLAN §6.1), para regenerar un link sin fricción.
 *
 * Las palabras gatillo son EDITABLES desde la UI (`keywords.pedir`). El default
 * param mantiene la función pura/sincrónica; `routeFlow` le pasa las del
 * catálogo.
 */

import { PEDIR_KEYWORDS } from '@/lib/bot/messages/defaults';

export function detectPedirIntent(
  text: string | undefined,
  keywords: readonly string[] = PEDIR_KEYWORDS,
): boolean {
  if (!text) return false;
  const norm = text.toLowerCase().trim();
  // Ignoramos mensajes vacíos o demasiado largos (probablemente no son una orden).
  if (norm.length === 0 || norm.length > 80) return false;
  return keywords.some(k => norm === k || norm.includes(k));
}

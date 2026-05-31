/**
 * Tipos del state machine del bot (mínimo).
 * Se persisten en chats.flow_state (jsonb).
 *
 * En el flujo nuevo el bot solo: saluda → manda el link de la tienda → seguimiento.
 * El catálogo, carrito, dirección y pago viven en la tienda web (`/pedir`), no en
 * el flow_state. Por eso este estado ya no guarda cart ni datos del cliente.
 */

export type FlowStep =
  | 'inicio'        // primer contacto / reinicio: saluda y ofrece pedir
  | 'menu'          // esperando que elija pedir / hablar con humano
  | 'link_enviado'  // ya le mandamos el link de la tienda; esperando pago/seguimiento
  | 'finalizado';   // flujo cerrado (lo marca el webhook al confirmar el pago)

export interface FlowState {
  step: FlowStep;
  isReturning?: boolean;       // pre-detectado al saludar (cliente recurrente)
  orderId?: string;            // último orderId/sesión de checkout generada (contexto)
  reminderSentAt?: string;     // lo usa el cron de inactividad para no spamear
}

export function emptyFlowState(): FlowState {
  return { step: 'inicio' };
}

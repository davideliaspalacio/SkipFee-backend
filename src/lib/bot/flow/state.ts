/**
 * Tipos del state machine del bot.
 * Se persisten en chats.flow_state (jsonb).
 *
 * El bot captura nombre + email + dirección + zona por WhatsApp ANTES de
 * mandar el link de la tienda. Cliente recurrente (con customer ya en BD)
 * salta el registro y solo confirma sus datos guardados.
 */

export type FlowStep =
  | 'inicio'                 // primer contacto / reinicio: saluda y ofrece pedir
  | 'menu'                   // esperando que elija pedir / hablar con humano

  // --- path RECURRENTE (datos ya en customers) ---
  | 'confirmar_recurrente'   // "¿pedimos a la misma dir?" → Sí | Cambiar dir

  // --- path NUEVO (registro) ---
  | 'registro_nombre'        // pidiendo nombre completo
  | 'registro_email'         // pidiendo correo
  | 'registro_confirmar'     // resumen nombre+email → Sí | No

  // --- path DIRECCIÓN ---
  | 'direccion_texto'        // pidiendo dirección por texto
  | 'direccion_zona'         // eligiendo zona (lista de botones)
  | 'direccion_confirmar'    // resumen dir + zona → Sí | Editar

  // --- post-link ---
  | 'link_enviado'           // ya le mandamos el link; esperando pago
  | 'finalizado';            // pago confirmado por webhook

/** Datos del cliente que el bot va recolectando en el flujo. */
export interface FlowCustomer {
  name?: string;
  email?: string;
}

/** Datos de entrega que el bot va recolectando en el flujo. */
export interface FlowDelivery {
  address?: string;
  zoneId?: string;
}

export interface FlowState {
  step: FlowStep;
  isReturning?: boolean;       // pre-detectado al saludar
  customer?: FlowCustomer;     // datos en construcción durante registro
  delivery?: FlowDelivery;     // datos en construcción durante dirección
  orderId?: string;            // último orderId/sesión generada (contexto)
  reminderSentAt?: string;     // lo usa el cron de inactividad para no spamear
}

export function emptyFlowState(): FlowState {
  return { step: 'inicio' };
}

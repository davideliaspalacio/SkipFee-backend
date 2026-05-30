/**
 * Tipos del state machine del bot.
 * Se persisten en chats.flow_state (jsonb).
 */

export type FlowStep =
  | 'consentimiento'         // esperando consentimiento de datos
  | 'menu_principal'         // nuevo: ¿pedir / ver carta / humano?
  | 'menu_recurrente'        // recurrente: ¿repetir último / nuevo / cambiar dir?
  | 'registro_nombre'        // pidiendo nombre completo
  | 'registro_email'         // pidiendo email
  | 'registro_confirmar'     // confirmar nombre + email
  | 'ubicacion'              // esperando location WhatsApp
  | 'direccion_texto'        // pidiendo dirección textual
  | 'direccion_confirmar'    // confirmar dirección + ¿guardar?
  | 'carta'                  // esperando selección producto
  | 'cantidad'               // esperando cantidad del producto elegido (botones 1/2/3+)
  | 'cantidad_custom'        // cliente clickeó "3+", esperando número exacto por texto
  | 'algo_mas'               // ¿agregar más o continuar?
  | 'resumen'                // resumen + confirmar
  | 'resumen_editar'         // editar carrito antes de confirmar (quitar items)
  | 'pago'                   // link Wompi enviado, esperando webhook
  | 'finalizado';            // flujo completo

export interface CartItem {
  productId: string;
  name: string;
  qty: number;
  price: number;
}

export interface FlowCustomerData {
  name?: string;
  email?: string;
  address?: string;
  lat?: number;
  lng?: number;
  zoneId?: string;       // resuelto a partir de la ubicación
  saveAddress?: boolean; // si el cliente eligió "Sí y guardar"
}

export interface FlowState {
  step: FlowStep;
  cart: {
    items: CartItem[];
    pendingProductId?: string;  // cuando estamos en 'cantidad'
  };
  customer: FlowCustomerData;
  consentGiven?: boolean;
  consentAskedAt?: string;
  orderId?: string;             // cuando se crea
  isReturning?: boolean;        // pre-detectado al inicio
}

export function emptyFlowState(): FlowState {
  return {
    step: 'consentimiento',
    cart: { items: [] },
    customer: {},
  };
}

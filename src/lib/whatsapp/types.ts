/**
 * Tipos del PUERTO de WhatsApp — comunes a todos los proveedores.
 *
 * Regla de diseño: estos tipos son el contrato INTERNO de Skipfee. Nacieron con
 * la forma de Kapso porque era el único proveedor, y se conservan tal cual a
 * propósito: cambiarlos obligaría a tocar los ~1100 líneas de handlers del bot
 * sin ganar nada. Los adaptadores traducen de/hacia su proveedor.
 */

/**
 * Resultado de un envío. `messages[0].id` es el identificador del mensaje en el
 * proveedor (wamid en Kapso, `key.id` en Evolution), que se persiste en
 * `messages.kapso_message_id` para casar los acuses de recibo.
 */
export interface SendResult {
  messages?: Array<{ id?: string }>;
}

/** Botón de respuesta rápida. `id` es lo que vuelve cuando el cliente lo pulsa. */
export interface ReplyButton {
  id: string;
  /** Texto visible. WhatsApp limita a 20 chars. */
  title: string;
}

/** Sección de una lista interactiva. Total de filas ≤ 10 en WhatsApp. */
export interface ListSection {
  title?: string;
  rows: Array<{
    id: string;
    title: string;
    description?: string;
  }>;
}

/** Header de un mensaje interactivo. Solo texto en el puerto común. */
export interface TextHeader {
  type: 'text';
  text: string;
}

export interface SendTextOpts {
  to: string;
  body: string;
}

export interface SendImageOpts {
  to: string;
  link: string;
  caption?: string;
}

export interface SendButtonsOpts {
  to: string;
  body: string;
  buttons: ReplyButton[];
  footer?: string;
  header?: TextHeader;
}

export interface SendListOpts {
  to: string;
  body: string;
  buttonText: string;
  sections: ListSection[];
  header?: string;
  footer?: string;
}

export interface SendCtaUrlOpts {
  to: string;
  body: string;
  displayText: string;
  url: string;
  header?: string;
  footer?: string;
}

/**
 * Qué sabe hacer NATIVAMENTE un proveedor.
 *
 * Cuando una capability es `false`, el adaptador NO falla: degrada. Por ejemplo
 * Evolution renderiza los botones como un menú de texto numerado. Los handlers
 * del bot nunca consultan esto — la degradación es responsabilidad exclusiva del
 * adaptador, para no regar conocimiento de proveedor por el state machine.
 */
export interface ProviderCapabilities {
  buttons: boolean;
  lists: boolean;
  ctaUrl: boolean;
  images: boolean;
  /** El proveedor emite acuses de entregado/leído. */
  deliveryStatus: boolean;
  /** El proveedor tiene sesión que puede caerse y requiere re-escanear QR. */
  session: boolean;
}

/** Tipo de contenido de un mensaje entrante, ya normalizado. */
export type InboundKind =
  | 'text'
  | 'interactive'
  | 'location'
  | 'image'
  | 'other';

/**
 * Mensaje entrante NORMALIZADO, independiente del proveedor.
 *
 * Cada adaptador traduce el payload de su webhook a esta forma; de aquí hacia
 * abajo (persistir, resolver el chat, despachar el bot) el código es compartido
 * y no sabe qué proveedor lo originó.
 */
export interface InboundEnvelope {
  /** Id del mensaje en el proveedor (para dedup y para casar acuses). */
  providerMessageId: string;
  /** Teléfono del cliente, solo dígitos con indicativo (ej. 573001234567). */
  from: string;
  /** Nombre que reporta WhatsApp, si viene. */
  contactName?: string;
  kind: InboundKind;
  /** Texto plano (kind='text'). */
  text?: string;
  /** Id del botón/fila que el cliente eligió (kind='interactive'). */
  interactiveId?: string;
  /** Título visible de la opción elegida, para persistir en el panel. */
  interactiveTitle?: string;
  location?: { lat: number; lng: number };
  image?: { id?: string; url?: string; caption?: string };
  /** Tipo crudo que reportó el proveedor, para debugging. */
  rawType?: string;
}

/** Estado de la sesión de un proveedor que la tenga (Evolution). */
export type SessionStatus = 'connected' | 'connecting' | 'disconnected' | 'unknown';

export interface SessionInfo {
  status: SessionStatus;
  /** QR en base64 (data URL) cuando hace falta escanear. */
  qr?: string | null;
  /** Número conectado, si el proveedor lo reporta. */
  phone?: string | null;
}

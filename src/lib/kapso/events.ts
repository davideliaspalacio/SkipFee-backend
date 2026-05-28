/**
 * Kapso platform webhook event types we plan to handle.
 * Source: https://docs.kapso.ai/docs/platform/webhooks/overview
 */
export type KapsoEventType =
  | 'whatsapp.message.received'
  | 'whatsapp.message.status'
  | 'whatsapp.call.received'
  | string;

export interface KapsoWebhookHeaders {
  event: KapsoEventType | null;
  signature: string | null;
  idempotencyKey: string | null;
  payloadVersion: string | null;
}

export interface IncomingMessagePayload {
  /** Phone number id of the receiver (our WABA number). */
  phoneNumberId: string;
  /** E.164 phone number that sent the message. */
  from: string;
  /** Kapso/Meta message id. */
  messageId: string;
  /** Message body (text). For non-text messages this may be empty. */
  text?: string;
  /** ISO timestamp. */
  timestamp: string;
  /** Raw event payload for fields we haven't typed yet. */
  raw: unknown;
}

export interface MessageStatusPayload {
  messageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | string;
  timestamp: string;
  raw: unknown;
}

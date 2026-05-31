import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Firmas de Wompi (Widget Checkout Web).
 *
 * Dos firmas DISTINTAS, con secretos DISTINTOS:
 *
 *  1. `integrity` (genera el backend, consume el Widget en el frontend):
 *     sha256(reference + amount_in_cents + currency [+ expiration_time] + INTEGRITY_SECRET)
 *     Garantiza que el monto/reference del checkout no fue manipulado en el browser.
 *
 *  2. `webhook` (la genera Wompi, la verifica el backend):
 *     sha256(<valores de signature.properties (en orden)> + timestamp + EVENTS_SECRET)
 *     Garantiza que el evento viene de Wompi (no de un atacante posteando a /webhooks/wompi).
 *     OJO: la doc oficial muestra el checksum en UPPERCASE; PHP/Ruby/Node lo
 *     producen en lowercase. Comparamos case-insensitive con timingSafeEqual.
 *
 * Refs:
 *  - https://docs.wompi.co/docs/colombia/widget-checkout-web/
 *  - https://docs.wompi.co/docs/colombia/eventos/
 */

// =========================================================================
// 1. Integrity (Widget Checkout)
// =========================================================================

export interface IntegrityInput {
  reference: string;
  amountInCents: number;
  currency: string;
  expirationTime?: string;
}

export function generateIntegritySignature(input: IntegrityInput): string {
  const secret = process.env.WOMPI_INTEGRITY_SECRET;
  if (!secret) {
    throw new Error(
      'WOMPI_INTEGRITY_SECRET no está configurado. Es requerido cuando WOMPI_MODE=real.',
    );
  }
  const { reference, amountInCents, currency, expirationTime } = input;
  const concat = expirationTime
    ? `${reference}${amountInCents}${currency}${expirationTime}${secret}`
    : `${reference}${amountInCents}${currency}${secret}`;
  return createHash('sha256').update(concat).digest('hex');
}

// =========================================================================
// 2. Webhook (verifica que el evento viene de Wompi)
// =========================================================================

interface WompiEventLike {
  data?: unknown;
  timestamp?: number;
  signature?: { properties?: string[]; checksum?: string };
}

/** Devuelve el checksum del header (preferido) o del body si está. */
export function extractEventChecksum(
  event: WompiEventLike,
  headerChecksum: string | null,
): string | null {
  if (headerChecksum) return headerChecksum;
  return event.signature?.checksum ?? null;
}

/**
 * Verifica la firma del webhook de Wompi.
 *
 * Algoritmo (doc oficial):
 *   1. Por cada `path` en `signature.properties` (en orden), extraer el valor
 *      del `event.data` y concatenar SIN SEPARADORES.
 *   2. Concatenar el `timestamp` (UNIX).
 *   3. Concatenar el events secret.
 *   4. sha256(concat) en hex.
 *   5. Comparar (case-insensitive) con el checksum recibido (header o body).
 *
 * `headerChecksum` opcional: si está, gana sobre `signature.checksum`.
 */
export function verifyWebhookSignature(
  event: WompiEventLike,
  headerChecksum?: string | null,
): boolean {
  const secret = process.env.WOMPI_EVENTS_SECRET;
  if (!secret) {
    throw new Error(
      'WOMPI_EVENTS_SECRET no está configurado. Es requerido cuando WOMPI_MODE=real.',
    );
  }

  const props = event.signature?.properties;
  const recv = extractEventChecksum(event, headerChecksum ?? null);
  if (!props || !recv || event.timestamp == null) return false;

  // Extrae cada propiedad de event.data según el path "transaction.id", etc.
  let concat = '';
  for (const path of props) {
    const value = path
      .split('.')
      .reduce<unknown>(
        (obj, key) => (obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined),
        event.data,
      );
    if (value === undefined || value === null) return false;
    concat += String(value);
  }
  concat += String(event.timestamp);
  concat += secret;

  const expected = createHash('sha256').update(concat).digest('hex');
  const a = Buffer.from(expected.toLowerCase(), 'hex');
  const b = Buffer.from(recv.toLowerCase(), 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

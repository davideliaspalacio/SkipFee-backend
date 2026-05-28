import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies the `X-Webhook-Signature` header that Kapso adds to every webhook.
 *
 * Kapso signs the raw JSON body with HMAC SHA256 using your webhook secret.
 * Always compare against the raw payload — re-stringifying after parsing
 * may change key order / whitespace and break verification.
 *
 * Docs: https://docs.kapso.ai/docs/platform/webhooks/security
 */
export function verifyKapsoSignature(opts: {
  rawBody: string;
  signature: string | null;
  secret: string;
}): boolean {
  if (!opts.signature) return false;

  const expected = createHmac('sha256', opts.secret).update(opts.rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(opts.signature, 'utf8');

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

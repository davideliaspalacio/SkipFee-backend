import type { NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { verifyKapsoSignature } from '@/lib/kapso/verify';
import { recordIdempotency } from '@/lib/kapso/handlers/dedup';
import { handleMessageReceived } from '@/lib/kapso/handlers/message-received';
import { handleMessageStatus } from '@/lib/kapso/handlers/message-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  const signature = request.headers.get('x-webhook-signature');
  const event = request.headers.get('x-webhook-event');
  const idempotencyKey = request.headers.get('x-idempotency-key');

  // 1. Verificar firma HMAC
  if (!verifyKapsoSignature({ rawBody, signature, secret: env.KAPSO_WEBHOOK_SECRET })) {
    return new Response('Invalid signature', { status: 401 });
  }

  // 2. Parsear payload
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // 3. Dedup por idempotency key (best-effort: si falla por otro motivo, seguimos)
  if (idempotencyKey) {
    try {
      const { duplicate } = await recordIdempotency({
        idempotencyKey,
        type: event ?? 'unknown',
        payload,
      });
      if (duplicate) {
        console.log('[kapso webhook] duplicate, skip', { idempotencyKey, event });
        return new Response('ok (duplicate)', { status: 200 });
      }
    } catch (err) {
      console.error('[kapso webhook] dedup error (continuamos)', err);
    }
  }

  console.log('[kapso webhook] dispatch', { event, idempotencyKey });

  // 4. Dispatch al handler correspondiente.
  // Importante: cualquier excepción NO debe devolver != 200, o Kapso reintenta
  // y duplicamos trabajo (aunque el dedup nos cubre, mejor evitarlo).
  try {
    switch (event) {
      case 'whatsapp.message.received':
        await handleMessageReceived(payload);
        break;
      case 'whatsapp.message.delivered':
      case 'whatsapp.message.read':
      case 'whatsapp.message.sent':
      case 'whatsapp.message.failed':
        await handleMessageStatus({ event, payload });
        break;
      default:
        console.log('[kapso webhook] unhandled event', { event });
    }
  } catch (err) {
    console.error('[kapso webhook] handler error', err);
  }

  return new Response('ok', { status: 200 });
}

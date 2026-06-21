import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { kapsoCredentialsFor, MissingIntegrationError } from '@/lib/integrations';
import { verifyKapsoSignature } from '@/lib/kapso/verify';
import { recordIdempotency } from '@/lib/kapso/handlers/dedup';
import { handleMessageReceived } from '@/lib/kapso/handlers/message-received';
import { handleMessageStatus } from '@/lib/kapso/handlers/message-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Webhook entrante de Kapso POR EMPRESA (multi-empresa).
 *
 * Cada empresa configura su webhook con su propia URL
 * `/api/webhooks/kapso/<companyId>`, donde `companyId` es el SLUG de la empresa.
 * Resolvemos la empresa por el slug del path, verificamos la firma con el
 * `kapso_webhook_secret` de ESA empresa, y propagamos el `company_id` (uuid) a
 * dedup + handlers para que todo quede scopeado a la empresa correcta.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId: companySlug } = await params;

  // 1. Resolver la empresa por slug → uuid.
  const { data: company } = await supabaseAdmin()
    .from('companies')
    .select('id, status')
    .eq('slug', companySlug)
    .maybeSingle();

  if (!company) {
    return new Response('Company not found', { status: 404 });
  }
  if (company.status === 'suspended') {
    return new Response('Company suspended', { status: 403 });
  }
  const companyId = company.id as string;

  const rawBody = await request.text();

  const signature = request.headers.get('x-webhook-signature');
  const event = request.headers.get('x-webhook-event');
  const idempotencyKey = request.headers.get('x-idempotency-key');

  // 2. Verificar firma HMAC con el secret de ESTA empresa.
  let webhookSecret: string | null;
  try {
    ({ webhookSecret } = await kapsoCredentialsFor(companyId));
  } catch (err) {
    if (err instanceof MissingIntegrationError) {
      console.error('[kapso webhook] empresa sin credenciales Kapso', {
        companySlug,
        companyId,
      });
      return new Response('Integration not configured', { status: 404 });
    }
    throw err;
  }

  if (!webhookSecret) {
    console.error('[kapso webhook] empresa sin kapso_webhook_secret', {
      companySlug,
      companyId,
    });
    return new Response('Webhook secret not configured', { status: 401 });
  }

  if (!verifyKapsoSignature({ rawBody, signature, secret: webhookSecret })) {
    return new Response('Invalid signature', { status: 401 });
  }

  // 3. Parsear payload
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // 4. Dedup por idempotency key, por empresa (PK (company_id, idempotency_key)).
  // best-effort: si falla por otro motivo, seguimos.
  if (idempotencyKey) {
    try {
      const { duplicate } = await recordIdempotency({
        idempotencyKey,
        type: event ?? 'unknown',
        payload,
        companyId,
      });
      if (duplicate) {
        console.log('[kapso webhook] duplicate, skip', { idempotencyKey, event, companyId });
        return new Response('ok (duplicate)', { status: 200 });
      }
    } catch (err) {
      console.error('[kapso webhook] dedup error (continuamos)', err);
    }
  }

  console.log('[kapso webhook] dispatch', { event, idempotencyKey, companyId });

  // 5. Dispatch al handler correspondiente.
  // Importante: cualquier excepción NO debe devolver != 200, o Kapso reintenta
  // y duplicamos trabajo (aunque el dedup nos cubre, mejor evitarlo).
  try {
    switch (event) {
      case 'whatsapp.message.received':
        await handleMessageReceived(payload, companyId);
        break;
      case 'whatsapp.message.delivered':
      case 'whatsapp.message.read':
      case 'whatsapp.message.sent':
      case 'whatsapp.message.failed':
        await handleMessageStatus({ event, payload, companyId });
        break;
      default:
        console.log('[kapso webhook] unhandled event', { event });
    }
  } catch (err) {
    console.error('[kapso webhook] handler error', err);
  }

  return new Response('ok', { status: 200 });
}

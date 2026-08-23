import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { MissingIntegrationError } from '@/lib/integrations';
import { providerFor } from '@/lib/whatsapp';
import { handleInboundMessage } from '@/lib/whatsapp/inbound';
import { recordIdempotency } from '@/lib/kapso/handlers/dedup';
import { mapEvolutionState, parseConnectionUpdate } from '@/lib/whatsapp/evolution/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Webhook entrante de Evolution API POR EMPRESA.
 *
 * Espejo de `/api/webhooks/kapso/[companyId]`: misma estructura, mismas
 * garantías (resolver empresa por slug → verificar → dedup → despachar), con
 * tres diferencias propias del proveedor:
 *
 *   1. **Autenticación más débil.** Evolution no firma el body con HMAC; lo
 *      mejor disponible es un token compartido en header. Por eso la URL del
 *      webhook debe tratarse como credencial y viajar siempre por HTTPS.
 *   2. **Dedup por `key.id`.** Evolution no manda un header de idempotencia,
 *      así que usamos el id del mensaje, que es estable entre reintentos.
 *   3. **Eventos de sesión.** `connection.update` no existe en Kapso; se
 *      persiste para que el panel sepa si hay que re-escanear el QR.
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

  if (!company) return new Response('Company not found', { status: 404 });
  if (company.status === 'suspended') {
    return new Response('Company suspended', { status: 403 });
  }
  const companyId = company.id as string;

  const rawBody = await request.text();

  // 2. Construir el proveedor y verificar con SUS reglas.
  let provider;
  try {
    provider = await providerFor(companyId);
  } catch (err) {
    if (err instanceof MissingIntegrationError) {
      console.error('[evolution webhook] empresa sin credenciales', {
        companySlug,
        companyId,
      });
      return new Response('Integration not configured', { status: 404 });
    }
    throw err;
  }

  // Si la empresa no está en Evolution, este webhook no le corresponde.
  // Responder 200 evita que Evolution reintente en bucle por una mala config.
  if (provider.kind !== 'evolution') {
    console.warn('[evolution webhook] empresa no usa Evolution', {
      companySlug,
      provider: provider.kind,
    });
    return new Response('ok (provider mismatch)', { status: 200 });
  }

  if (!provider.verifyWebhook({ rawBody, headers: request.headers })) {
    return new Response('Invalid token', { status: 401 });
  }

  // 3. Parsear
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // 4. Eventos de sesión — no son mensajes.
  const connection = parseConnectionUpdate(payload);
  if (connection) {
    // Se guarda traducido, no el crudo de Evolution ('open'), para que la
    // columna hable un solo idioma: la ruta de sesión escribe ahí lo mismo que
    // devuelve la API, y comparar dos vocabularios daría falsos cambios.
    const { error } = await supabaseAdmin()
      .from('company_integrations')
      .update({
        evolution_session_state: mapEvolutionState(connection.state),
        evolution_session_updated_at: new Date().toISOString(),
      })
      .eq('company_id', companyId);
    if (error) console.error('[evolution webhook] no se pudo guardar estado', error);
    console.log('[evolution webhook] connection.update', {
      companyId,
      state: connection.state,
      guardado: mapEvolutionState(connection.state),
    });
    return new Response('ok', { status: 200 });
  }

  // 5. Mensaje entrante
  const envelope = provider.parseInbound(payload);
  if (!envelope) return new Response('ok (ignored)', { status: 200 });

  // 6. Dedup por id de mensaje del proveedor.
  try {
    const { duplicate } = await recordIdempotency({
      idempotencyKey: `evolution:${envelope.providerMessageId}`,
      type: 'evolution.messages.upsert',
      payload,
      companyId,
    });
    if (duplicate) {
      console.log('[evolution webhook] duplicate, skip', {
        id: envelope.providerMessageId,
        companyId,
      });
      return new Response('ok (duplicate)', { status: 200 });
    }
  } catch (err) {
    console.error('[evolution webhook] dedup error (continuamos)', err);
  }

  // 7. Despachar. Igual que en Kapso: una excepción NO debe devolver != 200,
  // o el proveedor reintenta y duplicamos trabajo.
  try {
    await handleInboundMessage(envelope, companyId);
  } catch (err) {
    console.error('[evolution webhook] handler error', err);
  }

  return new Response('ok', { status: 200 });
}

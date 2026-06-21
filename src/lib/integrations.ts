import { WhatsAppClient } from '@kapso/whatsapp-cloud-api';
import { supabaseAdmin } from './db';
import { KAPSO_BASE_URL } from './kapso/client';

/**
 * Integraciones POR EMPRESA (multi-empresa).
 *
 * Kapso (WhatsApp) y Wompi (pagos) dejaron de ser credenciales globales del env
 * y pasaron a vivir en la tabla `company_integrations` (una fila por empresa,
 * PK = `company_id`). Este módulo es el ÚNICO punto que lee esa tabla y entrega
 * clientes/credenciales ya resueltos para una empresa concreta:
 *
 *   - `getCompanyIntegrations(companyId)` → fila cruda (cacheada en memoria).
 *   - `resolveCompanyByKapsoPhone(phoneNumberId)` → enruta el webhook entrante
 *     por el número que RECIBE el mensaje.
 *   - `kapsoFor(companyId)` → cliente Kapso + helpers de envío de esa empresa.
 *   - `wompiConfigFor(companyId)` → config Wompi de esa empresa.
 *
 * Acceso siempre con `supabaseAdmin()` (service_role): `company_integrations` es
 * sensible y no tiene policy pública.
 */

// =========================================================================
// Tipos
// =========================================================================

/** Fila cruda de `company_integrations` (snake_case, tal cual la BD). */
export interface CompanyIntegrations {
  company_id: string;
  kapso_phone_number_id: string | null;
  kapso_api_key: string | null;
  kapso_webhook_secret: string | null;
  wompi_mode: string;
  wompi_public_key: string | null;
  wompi_integrity_secret: string | null;
  wompi_events_secret: string | null;
  updated_at: string;
}

/** Credenciales Kapso resueltas y NO nulas para una empresa. */
export interface KapsoCredentials {
  apiKey: string;
  phoneNumberId: string;
  webhookSecret: string | null;
}

/** Config Wompi resuelta para una empresa. */
export interface WompiConfig {
  mode: 'mock' | 'real';
  publicKey: string | null;
  integritySecret: string | null;
  eventsSecret: string | null;
}

/** Cliente Kapso de una empresa: el SDK + helpers de envío parametrizados. */
export interface CompanyKapsoClient {
  client: WhatsAppClient;
  phoneNumberId: string;
  sendText(to: string, body: string): ReturnType<WhatsAppClient['messages']['sendText']>;
  sendImage(
    to: string,
    link: string,
    caption?: string,
  ): ReturnType<WhatsAppClient['messages']['sendImage']>;
}

/** Error claro cuando faltan credenciales de una integración por empresa. */
export class MissingIntegrationError extends Error {
  constructor(
    public readonly companyId: string,
    public readonly integration: 'kapso' | 'wompi',
    detail: string,
  ) {
    super(
      `Integración ${integration} no configurada para la empresa ${companyId}: ${detail}. ` +
        `Configura company_integrations para esta empresa.`,
    );
    this.name = 'MissingIntegrationError';
  }
}

// =========================================================================
// Cache en memoria (por companyId, TTL corto)
// =========================================================================

const CACHE_TTL_MS = 30_000; // 30s: suficiente para una ráfaga de requests.

interface CacheEntry {
  value: CompanyIntegrations;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Invalida la cache de una empresa (o toda si no se pasa companyId). */
export function invalidateIntegrationsCache(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

// =========================================================================
// getCompanyIntegrations
// =========================================================================

/**
 * Lee (y cachea por TTL corto) la fila de `company_integrations` de la empresa.
 * Lanza si la empresa no tiene fila de integraciones.
 */
export async function getCompanyIntegrations(
  companyId: string,
): Promise<CompanyIntegrations> {
  const now = Date.now();
  const hit = cache.get(companyId);
  if (hit && hit.expiresAt > now) return hit.value;

  const { data, error } = await supabaseAdmin()
    .from('company_integrations')
    .select(
      'company_id, kapso_phone_number_id, kapso_api_key, kapso_webhook_secret, ' +
        'wompi_mode, wompi_public_key, wompi_integrity_secret, wompi_events_secret, updated_at',
    )
    .eq('company_id', companyId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new Error(
      `No existe fila company_integrations para la empresa ${companyId}.`,
    );
  }

  const value = data as unknown as CompanyIntegrations;
  cache.set(companyId, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

// =========================================================================
// resolveCompanyByKapsoPhone
// =========================================================================

/**
 * Enruta un webhook entrante de WhatsApp a su empresa, a partir del
 * `phone_number_id` que RECIBE el mensaje. Usa el índice único
 * `company_integrations_kapso_phone_idx`. Devuelve `null` si ningún número
 * coincide (el caller decide si responde 404/ignora).
 */
export async function resolveCompanyByKapsoPhone(
  phoneNumberId: string,
): Promise<{ companyId: string } | null> {
  const { data, error } = await supabaseAdmin()
    .from('company_integrations')
    .select('company_id')
    .eq('kapso_phone_number_id', phoneNumberId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { companyId: data.company_id as string };
}

// =========================================================================
// kapsoFor
// =========================================================================

/**
 * Devuelve las credenciales Kapso (no nulas) de una empresa, o lanza
 * `MissingIntegrationError` si faltan api_key / phone_number_id.
 */
export async function kapsoCredentialsFor(
  companyId: string,
): Promise<KapsoCredentials> {
  const row = await getCompanyIntegrations(companyId);
  if (!row.kapso_api_key) {
    throw new MissingIntegrationError(companyId, 'kapso', 'falta kapso_api_key');
  }
  if (!row.kapso_phone_number_id) {
    throw new MissingIntegrationError(
      companyId,
      'kapso',
      'falta kapso_phone_number_id',
    );
  }
  return {
    apiKey: row.kapso_api_key,
    phoneNumberId: row.kapso_phone_number_id,
    webhookSecret: row.kapso_webhook_secret,
  };
}

/**
 * Cliente Kapso listo para usar de una empresa: reutiliza
 * `createKapsoClient` de `lib/kapso/client.ts` pero con las credenciales de la
 * empresa, y expone `sendText`/`sendImage` con el `phoneNumberId` correcto.
 *
 * Lanza `MissingIntegrationError` si la empresa no tiene credenciales Kapso.
 */
export async function kapsoFor(companyId: string): Promise<CompanyKapsoClient> {
  const { apiKey, phoneNumberId } = await kapsoCredentialsFor(companyId);
  const client = new WhatsAppClient({ baseUrl: KAPSO_BASE_URL, kapsoApiKey: apiKey });
  return {
    client,
    phoneNumberId,
    sendText: (to: string, body: string) =>
      client.messages.sendText({ phoneNumberId, to, body }),
    sendImage: (to: string, link: string, caption?: string) =>
      client.messages.sendImage({
        phoneNumberId,
        to,
        image: { link, ...(caption ? { caption } : {}) },
      }),
  };
}

// =========================================================================
// wompiConfigFor
// =========================================================================

/**
 * Devuelve la config Wompi de una empresa. `mode` siempre presente ('mock' por
 * defecto). Los secretos pueden ser null en modo mock; los handlers que los
 * necesiten (modo real) deben validarlos. Lanza `MissingIntegrationError` solo
 * si la fila de integraciones no existe.
 */
export async function wompiConfigFor(companyId: string): Promise<WompiConfig> {
  const row = await getCompanyIntegrations(companyId);
  const mode = row.wompi_mode === 'real' ? 'real' : 'mock';
  return {
    mode,
    publicKey: row.wompi_public_key,
    integritySecret: row.wompi_integrity_secret,
    eventsSecret: row.wompi_events_secret,
  };
}

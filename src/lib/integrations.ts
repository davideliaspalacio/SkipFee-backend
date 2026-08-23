import { WhatsAppClient } from '@kapso/whatsapp-cloud-api';
import { supabaseAdmin } from './db';
import { descifrarFila } from './crypto';
import { KAPSO_BASE_URL } from './whatsapp/kapso/constants';

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
  /** Proveedor de WhatsApp activo de la empresa. 'kapso' por defecto. */
  whatsapp_provider: 'kapso' | 'evolution';
  kapso_phone_number_id: string | null;
  kapso_api_key: string | null;
  kapso_webhook_secret: string | null;
  // Evolution API (self-hosted, canal no oficial)
  evolution_base_url: string | null;
  evolution_api_key: string | null;
  evolution_instance: string | null;
  evolution_webhook_token: string | null;
  /** Estado de la sesión Evolution ('open'|'connecting'|'close'). Kapso: null. */
  evolution_session_state: string | null;
  evolution_session_updated_at: string | null;
  /** Slug de la empresa (embebido). Se usa para derivar el nombre de instancia. */
  company_slug: string | null;
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
    public readonly integration: 'kapso' | 'evolution' | 'wompi',
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
      'company_id, whatsapp_provider, ' +
        'kapso_phone_number_id, kapso_api_key, kapso_webhook_secret, ' +
        'evolution_base_url, evolution_api_key, evolution_instance, evolution_webhook_token, ' +
        'evolution_session_state, evolution_session_updated_at, ' +
        'companies(slug), ' +
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

  // PostgREST devuelve el embed como objeto anidado; lo aplanamos.
  // `descifrarFila` deja los secretos en claro para el resto del backend: nadie
  // más tiene que acordarse de descifrar, y el cifrado no se filtra al código
  // de negocio.
  const raw = descifrarFila(data as unknown as Record<string, unknown>);
  const embedded = raw.companies as { slug?: string } | null | undefined;
  const value = {
    ...raw,
    company_slug: embedded?.slug ?? null,
  } as unknown as CompanyIntegrations;
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
// Evolution (canal no oficial)
// =========================================================================

/** Credenciales Evolution resueltas y NO nulas para una empresa. */
export interface EvolutionCredentials {
  baseUrl: string;
  apiKey: string;
  instance: string;
  webhookToken: string | null;
}

/**
 * Devuelve las credenciales Evolution de una empresa, o lanza
 * `MissingIntegrationError` si faltan las obligatorias.
 *
 * No se valida a nivel de BD (no hay CHECK) a propósito: el flujo de alta es
 * "crear empresa → elegir proveedor → cargar credenciales", y un CHECK impediría
 * el paso intermedio. La validación vive acá, igual que en `kapsoCredentialsFor`.
 */
export async function evolutionCredentialsFor(
  companyId: string,
): Promise<EvolutionCredentials> {
  const row = await getCompanyIntegrations(companyId);

  // Servidor COMPARTIDO de Skipfee por defecto. La fila de la empresa solo se
  // usa como override (cliente que trae su propio servidor), no como requisito:
  // al restaurante no se le pide infraestructura, únicamente escanea el QR.
  const baseUrl = row.evolution_base_url ?? process.env.EVOLUTION_BASE_URL ?? null;
  const apiKey = row.evolution_api_key ?? process.env.EVOLUTION_API_KEY ?? null;

  if (!baseUrl) {
    throw new MissingIntegrationError(
      companyId,
      'evolution',
      'no hay servidor Evolution configurado (ni EVOLUTION_BASE_URL en el env, ' +
        'ni evolution_base_url para esta empresa)',
    );
  }
  if (!apiKey) {
    throw new MissingIntegrationError(
      companyId,
      'evolution',
      'falta la llave del servidor Evolution (EVOLUTION_API_KEY o evolution_api_key)',
    );
  }

  return {
    baseUrl,
    apiKey,
    // El nombre de instancia se deriva del slug la primera vez y se persiste al
    // conectar (índice único en `evolution_instance`). Así cada negocio es una
    // instancia identificable dentro del servidor compartido.
    instance: row.evolution_instance ?? instanceNameFor(row.company_slug, companyId),
    webhookToken: row.evolution_webhook_token,
  };
}

/**
 * Nombre de instancia para una empresa dentro del servidor compartido.
 * Solo `[a-zA-Z0-9._-]` (viaja en la URL de Evolution). Cae al uuid si por
 * alguna razón no hay slug.
 */
export function instanceNameFor(
  slug: string | null | undefined,
  companyId: string,
): string {
  const base = (slug ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return base.length >= 2 ? base : `co-${companyId.slice(0, 8)}`;
}

/**
 * Enruta un webhook entrante de Evolution a su empresa por el nombre de
 * instancia. Análogo a `resolveCompanyByKapsoPhone`.
 */
export async function resolveCompanyByEvolutionInstance(
  instance: string,
): Promise<{ companyId: string } | null> {
  const { data, error } = await supabaseAdmin()
    .from('company_integrations')
    .select('company_id')
    .eq('evolution_instance', instance)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { companyId: data.company_id as string };
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

/**
 * Identidad de la empresa para el prompt del agente de IA.
 *
 * Se cachea en memoria con TTL corto, igual que el catálogo de mensajes y las
 * integraciones: el nombre, las zonas y el horario cambian rara vez, y el
 * agente construye el prompt en cada mensaje entrante.
 */

import { supabaseAdmin } from '@/lib/db';
import type { BusinessContext } from './prompt';

const CACHE_TTL_MS = 60_000;

interface Slot {
  at: number;
  value: BusinessContext;
}

const cache = new Map<string, Slot>();

/** Invalida la cache de una empresa (o toda). La usan settings y zonas al editar. */
export function invalidateBusinessContext(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

/**
 * Carga nombre, descripción, zonas y horario de la empresa.
 *
 * Best-effort: si algo falla devuelve lo que tenga. El prompt se degrada solo
 * cuando faltan datos — es preferible un prompt corto a uno que afirme algo
 * falso sobre el negocio.
 */
export async function loadBusinessContext(
  companyId: string | undefined,
): Promise<BusinessContext> {
  if (!companyId) return {};

  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const sb = supabaseAdmin();
  const [companyRes, settingsRes, zonesRes] = await Promise.all([
    sb.from('companies').select('name').eq('id', companyId).maybeSingle(),
    sb
      .from('settings')
      .select('business_description, open_hour, close_hour')
      .eq('company_id', companyId)
      .maybeSingle(),
    sb
      .from('zones')
      .select('name')
      .eq('company_id', companyId)
      .eq('archived', false),
  ]);

  const value: BusinessContext = {
    name: (companyRes.data?.name as string | undefined) ?? null,
    description: (settingsRes.data?.business_description as string | null) ?? null,
    openHour: (settingsRes.data?.open_hour as string | null) ?? null,
    closeHour: (settingsRes.data?.close_hour as string | null) ?? null,
    zoneNames: (zonesRes.data ?? []).map(z => z.name as string).filter(Boolean),
  };

  cache.set(companyId, { at: Date.now(), value });
  return value;
}

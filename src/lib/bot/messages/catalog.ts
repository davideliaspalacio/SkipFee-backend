/**
 * Resolver del catálogo de mensajes: mergea los defaults del código con los
 * overrides de la tabla `bot_messages` y cachea el resultado en memoria.
 *
 * Multi-empresa: el catálogo es POR EMPRESA. `bot_messages` tiene PK
 * `(company_id, key)`, así que las queries se scopean con `.eq('company_id', …)`
 * y la cache se keyea por `companyId`. Todas las funciones públicas reciben un
 * `companyId` OPCIONAL: cuando se pasa (el bot ya migrado), lee/cachea los
 * overrides de esa empresa; cuando NO se pasa (callers de sistema aún sin
 * migrar: `orders/notify`, `cron/inactivity-check`, rutas `bot/messages`), cae
 * al comportamiento legacy (cache global, query sin `company_id`) para no romper
 * el build. Esos callers están marcados con TODO en sus archivos.
 *
 * Garantía de robustez: si la lectura a BD falla (env ausente, red caída,
 * tabla inexistente) se usan los defaults. El bot NUNCA se rompe por esto.
 */

import { supabaseAdmin } from '@/lib/db';
import type { FlowStep } from '../flow/state';
import {
  MESSAGE_DEFS,
  MESSAGE_DEFS_LIST,
  type MessageCategory,
  type MessageContent,
  type MessageDef,
  type MessageKind,
} from './defaults';

export interface ResolvedMessage extends MessageContent {
  key: string;
  kind: MessageKind;
  enabled: boolean;
  isCustomized: boolean;
  body: string; // siempre string ('' si el kind no usa body)
  updatedAt?: string;
}

interface OverrideRow {
  key: string;
  content: MessageContent | null;
  enabled: boolean | null;
  updated_at?: string | null;
}

const CACHE_TTL_MS = 60_000;

/** Clave de cache: el companyId, o '__global__' para el modo legacy sin empresa. */
const GLOBAL_KEY = '__global__';

interface CacheSlot {
  cache: { at: number; map: Map<string, ResolvedMessage> } | null;
  inflight: Promise<Map<string, ResolvedMessage>> | null;
}

/** Una entrada de cache por empresa (más la global legacy). */
const slots = new Map<string, CacheSlot>();

function slotFor(companyId?: string): CacheSlot {
  const key = companyId ?? GLOBAL_KEY;
  let slot = slots.get(key);
  if (!slot) {
    slot = { cache: null, inflight: null };
    slots.set(key, slot);
  }
  return slot;
}

function resolveOne(def: MessageDef, override?: OverrideRow): ResolvedMessage {
  const hasOverride = !!override?.content;
  const content: MessageContent = hasOverride
    ? { ...def.default, ...override!.content }
    : { ...def.default };
  return {
    key: def.key,
    kind: def.kind,
    enabled: override?.enabled ?? true,
    isCustomized: hasOverride,
    updatedAt: override?.updated_at ?? undefined,
    ...content,
    body: content.body ?? '',
  };
}

function buildDefaultsMap(): Map<string, ResolvedMessage> {
  const map = new Map<string, ResolvedMessage>();
  for (const def of MESSAGE_DEFS_LIST) map.set(def.key, resolveOne(def));
  return map;
}

async function fetchOverrides(companyId?: string): Promise<OverrideRow[]> {
  try {
    let query = supabaseAdmin()
      .from('bot_messages')
      .select('key, content, enabled, updated_at');
    // Multi-empresa: solo los overrides de ESTA empresa. Sin companyId (legacy),
    // lee toda la tabla (compat single-tenant).
    if (companyId) query = query.eq('company_id', companyId);
    const { data, error } = await query;
    if (error || !data) return [];
    return data as OverrideRow[];
  } catch {
    // env ausente / red caída / tabla inexistente → sin overrides (defaults).
    return [];
  }
}

async function buildCatalog(companyId?: string): Promise<Map<string, ResolvedMessage>> {
  const overrides = await fetchOverrides(companyId);
  const byKey = new Map(overrides.map(o => [o.key, o]));
  const map = new Map<string, ResolvedMessage>();
  for (const def of MESSAGE_DEFS_LIST) map.set(def.key, resolveOne(def, byKey.get(def.key)));
  return map;
}

async function loadCatalog(companyId?: string): Promise<Map<string, ResolvedMessage>> {
  const slot = slotFor(companyId);
  const now = Date.now();
  if (slot.cache && now - slot.cache.at < CACHE_TTL_MS) return slot.cache.map;
  if (slot.inflight) return slot.inflight;
  slot.inflight = buildCatalog(companyId)
    .then(map => {
      slot.cache = { at: Date.now(), map };
      slot.inflight = null;
      return map;
    })
    .catch(() => {
      slot.inflight = null;
      return buildDefaultsMap();
    });
  return slot.inflight;
}

/** Resuelve un mensaje por key (default ⊕ override) de la empresa. Nunca lanza. */
export async function getMessage(key: string, companyId?: string): Promise<ResolvedMessage> {
  const map = await loadCatalog(companyId);
  const found = map.get(key);
  if (found) return found;
  const def = MESSAGE_DEFS[key];
  if (def) return resolveOne(def);
  // key desconocida → texto vacío seguro (no debería ocurrir).
  return { key, kind: 'text', enabled: true, isCustomized: false, body: '' };
}

/** Palabras gatillo de un mensaje `keywords.*` (o [] si no aplica). */
export async function getKeywords(key: string, companyId?: string): Promise<string[]> {
  const m = await getMessage(key, companyId);
  return m.words ?? [];
}

/** Todos los mensajes resueltos de la empresa, en orden del catálogo. */
export async function getAllMessages(companyId?: string): Promise<ResolvedMessage[]> {
  const map = await loadCatalog(companyId);
  return MESSAGE_DEFS_LIST.map(d => map.get(d.key)!).filter(Boolean);
}

/** Reconstruye el objeto `content` limpio (según el kind) desde el resuelto. */
function contentOf(kind: MessageKind, r: ResolvedMessage): MessageContent {
  switch (kind) {
    case 'text': return { body: r.body };
    case 'buttons': return { body: r.body, buttons: r.buttons ?? [] };
    case 'list': return { body: r.body, buttonText: r.buttonText, rowDescriptionTemplate: r.rowDescriptionTemplate };
    case 'cta_url': return { body: r.body, displayText: r.displayText };
    case 'prompt': return { systemPrompt: r.systemPrompt, safeDefault: r.safeDefault };
    case 'keywords': return { words: r.words ?? [] };
  }
}

/** Mensaje con toda la metadata + contenido (resuelto y default) para la UI admin. */
export interface AdminMessage {
  key: string;
  category: MessageCategory;
  step: FlowStep | null;
  kind: MessageKind;
  label: string;
  description: string | null;
  variables: string[];
  content: MessageContent;        // merged: default ⊕ override
  defaultContent: MessageContent; // el default del código (referencia)
  isCustomized: boolean;
  enabled: boolean;
  updatedAt: string | null;
}

/** Catálogo completo para el panel admin (metadata + contenido resuelto). */
export async function getAdminCatalog(companyId?: string): Promise<AdminMessage[]> {
  const map = await loadCatalog(companyId);
  return MESSAGE_DEFS_LIST.map(def => {
    const r = map.get(def.key)!;
    return {
      key: def.key,
      category: def.category,
      step: def.step ?? null,
      kind: def.kind,
      label: def.label,
      description: def.description ?? null,
      variables: def.variables,
      content: contentOf(def.kind, r),
      defaultContent: def.default,
      isCustomized: r.isCustomized,
      enabled: r.enabled,
      updatedAt: r.updatedAt ?? null,
    };
  });
}

/**
 * Invalida la cache de una empresa (lo llama el PATCH tras guardar un override).
 * Sin companyId limpia TODAS las entradas (legacy + todas las empresas).
 */
export function invalidateCatalog(companyId?: string): void {
  if (companyId === undefined) {
    slots.clear();
    return;
  }
  slots.delete(companyId);
}

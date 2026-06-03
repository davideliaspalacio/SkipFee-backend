/**
 * Resolver del catálogo de mensajes: mergea los defaults del código con los
 * overrides de la tabla `bot_messages` y cachea el resultado en memoria.
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

let cache: { at: number; map: Map<string, ResolvedMessage> } | null = null;
let inflight: Promise<Map<string, ResolvedMessage>> | null = null;

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

async function fetchOverrides(): Promise<OverrideRow[]> {
  try {
    const { data, error } = await supabaseAdmin()
      .from('bot_messages')
      .select('key, content, enabled, updated_at');
    if (error || !data) return [];
    return data as OverrideRow[];
  } catch {
    // env ausente / red caída / tabla inexistente → sin overrides (defaults).
    return [];
  }
}

async function buildCatalog(): Promise<Map<string, ResolvedMessage>> {
  const overrides = await fetchOverrides();
  const byKey = new Map(overrides.map(o => [o.key, o]));
  const map = new Map<string, ResolvedMessage>();
  for (const def of MESSAGE_DEFS_LIST) map.set(def.key, resolveOne(def, byKey.get(def.key)));
  return map;
}

async function loadCatalog(): Promise<Map<string, ResolvedMessage>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.map;
  if (inflight) return inflight;
  inflight = buildCatalog()
    .then(map => {
      cache = { at: Date.now(), map };
      inflight = null;
      return map;
    })
    .catch(() => {
      inflight = null;
      return buildDefaultsMap();
    });
  return inflight;
}

/** Resuelve un mensaje por key (default ⊕ override). Nunca lanza. */
export async function getMessage(key: string): Promise<ResolvedMessage> {
  const map = await loadCatalog();
  const found = map.get(key);
  if (found) return found;
  const def = MESSAGE_DEFS[key];
  if (def) return resolveOne(def);
  // key desconocida → texto vacío seguro (no debería ocurrir).
  return { key, kind: 'text', enabled: true, isCustomized: false, body: '' };
}

/** Palabras gatillo de un mensaje `keywords.*` (o [] si no aplica). */
export async function getKeywords(key: string): Promise<string[]> {
  const m = await getMessage(key);
  return m.words ?? [];
}

/** Todos los mensajes resueltos, en orden del catálogo. */
export async function getAllMessages(): Promise<ResolvedMessage[]> {
  const map = await loadCatalog();
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
export async function getAdminCatalog(): Promise<AdminMessage[]> {
  const map = await loadCatalog();
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

/** Invalida la cache (lo llama el PATCH tras guardar un override). */
export function invalidateCatalog(): void {
  cache = null;
  inflight = null;
}

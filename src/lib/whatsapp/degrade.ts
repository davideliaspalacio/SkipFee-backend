/**
 * DEGRADACIÓN de mensajes interactivos a texto numerado.
 *
 * Los proveedores no oficiales (Evolution) no soportan botones ni listas de
 * forma confiable. En vez de que el bot pregunte "¿tengo botones?" en cada uno
 * de sus ~10 puntos de envío, el adaptador degrada solo: renderiza un menú de
 * texto numerado y el state machine ni se entera.
 *
 * ⚠️ LA DEGRADACIÓN ES UN PAR, NO UNA FUNCIÓN.
 *
 * Mandar el menú es la mitad fácil. La otra mitad es que cuando el cliente
 * responde "2", ese "2" tiene que volver a convertirse en el id del botón
 * original (`btn_pedir`) antes de llegar al state machine — si no, el handler
 * no reconoce la respuesta y el bot se queda mudo a mitad del pedido.
 *
 * Por eso este módulo exporta las dos mitades juntas:
 *   - `renderNumberedMenu`  → salida: texto + qué opciones se ofrecieron
 *   - `matchPendingOption`  → entrada: respuesta del cliente → id original
 *
 * Las opciones ofrecidas se persisten en `chats.pending_options` (ver
 * `pending.ts`), no en `flow_state`, para que `saveFlowState` no las pise.
 */

/** Una opción ofrecida en un menú degradado. */
export interface PendingOption {
  /** Lo que el cliente debe escribir: "1", "2", ... */
  key: string;
  /** Id original del botón/fila, que espera el state machine. */
  id: string;
  /** Título visible, para poder casar también por texto. */
  title: string;
}

export interface PendingOptions {
  options: PendingOption[];
  sentAt: string;
}

/** Emojis de dígito, más legibles que "1." en WhatsApp. */
const DIGIT_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function digitLabel(n: number): string {
  return DIGIT_EMOJI[n - 1] ?? `${n}.`;
}

/**
 * Quita tildes, emojis de dígito y puntuación de borde para comparar.
 * "2️⃣" → "2" ; "  Sí, guardar. " → "si, guardar"
 */
export function normalizeReply(raw: string): string {
  let s = raw.trim().toLowerCase();
  // Emojis de dígito → dígito ASCII
  DIGIT_EMOJI.forEach((emoji, i) => {
    s = s.split(emoji).join(String(i + 1));
  });
  // Quitar variation selectors / keycaps sueltos que deja WhatsApp
  s = s.replace(/[\uFE0F\u20E3]/g, '');
  // Quitar tildes
  s = s.normalize('NFD').replace(/[\u0300-\u036F]/g, '');
  // Puntuación de borde: "2." "2)" "-2-" "¡2!"
  s = s.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
  return s.trim();
}

/**
 * Convierte un set de opciones interactivas en un mensaje de texto numerado.
 *
 * Devuelve el texto a enviar y las `PendingOptions` que hay que persistir para
 * poder interpretar la respuesta. El caller (el adaptador) es responsable de
 * guardarlas — este módulo es puro y testeable.
 */
export function renderNumberedMenu(opts: {
  body: string;
  options: Array<{ id: string; title: string; description?: string }>;
  header?: string;
  footer?: string;
  /** Texto de cierre. Se puede personalizar por si el catálogo lo cambia. */
  prompt?: string;
}): { text: string; pending: PendingOptions } {
  const parts: string[] = [];

  if (opts.header) parts.push(`*${opts.header}*`);
  if (opts.body) parts.push(opts.body);

  const options: PendingOption[] = [];
  const lines: string[] = [];

  opts.options.forEach((o, i) => {
    const key = String(i + 1);
    options.push({ key, id: o.id, title: o.title });
    const desc = o.description ? `\n   _${o.description}_` : '';
    lines.push(`${digitLabel(i + 1)} ${o.title}${desc}`);
  });

  if (lines.length > 0) parts.push(lines.join('\n'));

  const prompt =
    opts.prompt ??
    (options.length === 1
      ? 'Responde *1* para continuar.'
      : `Responde con el número de la opción (1-${options.length}).`);
  parts.push(prompt);

  if (opts.footer) parts.push(`_${opts.footer}_`);

  return {
    text: parts.join('\n\n'),
    pending: { options, sentAt: new Date().toISOString() },
  };
}

/**
 * Menú degradado para un CTA con URL. No hay opciones que numerar: el link va
 * en el cuerpo. No genera `PendingOptions` (no hay nada que mapear de vuelta).
 */
export function renderCtaAsText(opts: {
  body: string;
  displayText: string;
  url: string;
  header?: string;
  footer?: string;
}): string {
  const parts: string[] = [];
  if (opts.header) parts.push(`*${opts.header}*`);
  parts.push(opts.body);
  parts.push(`👉 ${opts.displayText}:\n${opts.url}`);
  if (opts.footer) parts.push(`_${opts.footer}_`);
  return parts.join('\n\n');
}

/**
 * ENTRADA: dado el texto que escribió el cliente y las opciones que se le
 * ofrecieron, devuelve el id original de la opción elegida (o null).
 *
 * Acepta, en este orden:
 *   1. El número: "2", "2.", "2)", "2️⃣"
 *   2. El título exacto (sin tildes ni mayúsculas): "hacer pedido"
 *   3. El título como prefijo, por si el cliente escribe de más:
 *      "hacer pedido por favor"
 *
 * Deliberadamente NO hace matching difuso: un falso positivo mete al cliente
 * en una rama equivocada del flujo, que es peor que no entender y repreguntar.
 */
export function matchPendingOption(
  rawText: string | undefined,
  pending: PendingOptions | null | undefined,
): string | null {
  if (!rawText || !pending?.options?.length) return null;

  const norm = normalizeReply(rawText);
  if (!norm) return null;

  // 1. Por número
  const byKey = pending.options.find(o => o.key === norm);
  if (byKey) return byKey.id;

  // 2. Por título exacto
  const byTitle = pending.options.find(
    o => normalizeReply(o.title) === norm,
  );
  if (byTitle) return byTitle.id;

  // 3. Por título como prefijo (solo si el título tiene sustancia)
  const byPrefix = pending.options.find(o => {
    const t = normalizeReply(o.title);
    return t.length >= 4 && norm.startsWith(t);
  });
  if (byPrefix) return byPrefix.id;

  return null;
}

/** Aplana las secciones de una lista a opciones planas y numeradas. */
export function flattenSections(
  sections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }>,
): Array<{ id: string; title: string; description?: string }> {
  return sections.flatMap(s =>
    s.rows.map(r => ({
      id: r.id,
      // Prefijamos la sección para que el cliente no pierda el contexto
      // cuando la lista tiene varias ("Combos · Sub de pollo").
      title: s.title ? `${s.title} · ${r.title}` : r.title,
      description: r.description,
    })),
  );
}

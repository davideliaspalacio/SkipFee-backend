/**
 * Validación del `content` editado de un mensaje, según su `kind`.
 *
 * Reglas duras (bloquean el guardado):
 * - Formas por kind (body/buttons/list/cta_url/prompt/keywords).
 * - Límites de WhatsApp: body ≤ 1024, título de botón ≤ 20, ≤ 3 botones,
 *   texto de botón de lista ≤ 20.
 * - Los `id` de los botones NO se pueden cambiar (son el binding lógico que
 *   los handlers matchean). Solo el `title` es editable.
 *
 * Reglas blandas (warning, no bloquean): variables `{{x}}` no declaradas para
 * ese mensaje — `render` las deja vacías, así que es seguro pero conviene avisar.
 */

import { z } from 'zod';
import { extractVariables } from './render';
import type { MessageContent, MessageDef, MessageKind } from './defaults';

const BODY_MAX = 1024;
const BTN_MAX = 20;

const buttonSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1, 'Título vacío').max(BTN_MAX, `Máx ${BTN_MAX} caracteres (límite de WhatsApp)`),
});

function schemaFor(kind: MessageKind): z.ZodTypeAny {
  switch (kind) {
    case 'text':
      return z.object({ body: z.string().min(1).max(BODY_MAX) });
    case 'buttons':
      return z.object({
        body: z.string().min(1).max(BODY_MAX),
        buttons: z.array(buttonSchema).min(1).max(3),
      });
    case 'list':
      return z.object({
        body: z.string().min(1).max(BODY_MAX),
        buttonText: z.string().min(1).max(BTN_MAX),
        rowDescriptionTemplate: z.string().max(72).optional(),
      });
    case 'cta_url':
      return z.object({
        body: z.string().min(1).max(BODY_MAX),
        displayText: z.string().min(1).max(BTN_MAX),
      });
    case 'prompt':
      return z.object({
        systemPrompt: z.string().min(1).max(8000),
        safeDefault: z.string().min(1).max(BODY_MAX),
      });
    case 'keywords':
      return z.object({
        words: z.array(z.string().min(1).max(60)).min(1).max(40),
      });
  }
}

export interface ContentValidation {
  ok: boolean;
  content?: MessageContent;
  errors?: { path: string; message: string }[];
  warnings?: string[];
}

export function validateContent(def: MessageDef, raw: unknown): ContentValidation {
  const parsed = schemaFor(def.kind).safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const content = parsed.data as MessageContent;

  // Los ids de botones no se pueden cambiar (binding lógico de los handlers).
  if (def.kind === 'buttons') {
    const defIds = (def.default.buttons ?? []).map(b => b.id).sort();
    const gotIds = (content.buttons ?? []).map(b => b.id).sort();
    if (defIds.length !== gotIds.length || defIds.some((id, i) => id !== gotIds[i])) {
      return {
        ok: false,
        errors: [{
          path: 'buttons',
          message: 'No se pueden agregar, quitar ni cambiar los ids de los botones (solo el texto).',
        }],
      };
    }
  }

  // Variables no declaradas → warning (render las deja vacías).
  const used = new Set<string>();
  const textFields = [
    content.body, content.buttonText, content.rowDescriptionTemplate,
    content.displayText, content.systemPrompt, content.safeDefault,
  ];
  for (const f of textFields) if (typeof f === 'string') extractVariables(f).forEach(v => used.add(v));
  for (const b of content.buttons ?? []) extractVariables(b.title).forEach(v => used.add(v));

  const allowed = new Set(def.variables);
  const unknown = [...used].filter(v => !allowed.has(v));
  const warnings = unknown.length
    ? [`Variables no reconocidas (se mostrarán vacías): ${unknown.map(v => `{{${v}}}`).join(', ')}`]
    : undefined;

  return { ok: true, content, warnings };
}

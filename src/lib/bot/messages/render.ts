/**
 * Interpolación segura de plantillas de mensajes del bot.
 *
 * Las plantillas usan la notación `{{variable}}`. `render` reemplaza cada
 * `{{x}}` por `vars.x`. Reglas de seguridad — el bot NUNCA debe romperse por
 * una edición desde la UI:
 *
 * - Variable ausente/undefined/null → se reemplaza por '' (cadena vacía).
 * - Se toleran espacios dentro de las llaves: `{{ nombre }}` == `{{nombre}}`.
 * - Todo lo que no sea una llave se deja intacto. En particular un `$` justo
 *   antes de `{{x}}` queda literal (lo usamos para precios: `domicilio ${{tarifa}}`).
 */

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export type RenderVars = Record<string, string | number | null | undefined>;

export function render(template: string, vars: RenderVars = {}): string {
  return template.replace(VAR_RE, (_match, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Nombres de variables (únicos) usados en una plantilla. Para validación/UI. */
export function extractVariables(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) out.add(m[1]);
  return [...out];
}

/**
 * Constantes de Kapso SIN efectos de importación.
 *
 * Vive aparte de `lib/kapso/client.ts` a propósito: ese módulo construye un
 * cliente global al importarse y para eso lee el env, así que importarlo desde
 * el adaptador arrastraba esa validación a cualquier consumidor del puerto
 * (incluidos los tests). El puerto no debe depender del env global.
 */
export const KAPSO_BASE_URL = 'https://app.kapso.ai/api/meta/';

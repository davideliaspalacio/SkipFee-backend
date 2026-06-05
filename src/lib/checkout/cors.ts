/**
 * CORS para los endpoints públicos que consume la tienda web (`/pedir`).
 *
 * La tienda corre en otro origen y llama sin `Authorization` — el secreto es el
 * `orderId` (uuid). Habilitamos CORS (incluido el preflight OPTIONS) hacia los
 * orígenes permitidos.
 *
 * Origen reflejado: si el `Origin` del request está en `allowedOrigins()`
 * (localhost de dev + `STOREFRONT_ORIGIN` + `EXTRA_CORS_ORIGINS`, ver access.ts),
 * lo devolvemos tal cual; si no, caemos a `STOREFRONT_ORIGIN` (o `*`). Esto
 * permite probar el frontend en `localhost:5173` contra el backend desplegado
 * (cuyo `STOREFRONT_ORIGIN` apunta al dominio de producción) sin romper prod.
 *
 * El `Origin` se lee del request con `next/headers` para no tener que pasarlo en
 * cada una de las llamadas a `jsonWithCors` de los route handlers. Fuera de un
 * request scope (p. ej. en tests unitarios que invocan el helper directo)
 * `headers()` no está disponible: caemos al comportamiento por `STOREFRONT_ORIGIN`.
 */

import { headers } from 'next/headers';
import { allowedOrigins } from './access';

/** Origen al que respondemos CORS para esta request. */
async function resolveStorefrontOrigin(): Promise<string> {
  let requestOrigin: string | null = null;
  try {
    requestOrigin = (await headers()).get('origin');
  } catch {
    // Fuera de un request scope (tests / build). Usamos el default por env.
  }
  if (requestOrigin && allowedOrigins().includes(requestOrigin)) return requestOrigin;
  return process.env.STOREFRONT_ORIGIN || '*';
}

export async function corsHeaders(): Promise<Record<string, string>> {
  return {
    'Access-Control-Allow-Origin': await resolveStorefrontOrigin(),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Respuesta al preflight OPTIONS. */
export async function preflight(): Promise<Response> {
  return new Response(null, { status: 204, headers: await corsHeaders() });
}

/** Igual que Response.json pero adjuntando los headers CORS. */
export async function jsonWithCors(body: unknown, status = 200): Promise<Response> {
  return Response.json(body, { status, headers: await corsHeaders() });
}

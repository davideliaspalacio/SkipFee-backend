/**
 * CORS para los endpoints públicos que consume la tienda web (`/pedir`).
 *
 * La tienda corre en otro origen (`STOREFRONT_ORIGIN`, ej. http://localhost:5173)
 * y llama sin `Authorization` — el secreto es el `orderId` (uuid). Habilitamos
 * CORS (incluido el preflight OPTIONS) hacia ese origen.
 *
 * Se lee `process.env.STOREFRONT_ORIGIN` en cada request (no se cachea) para no
 * fijar el valor en build y para que los tests puedan variarlo.
 */

export function storefrontOrigin(): string {
  return process.env.STOREFRONT_ORIGIN || '*';
}

export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': storefrontOrigin(),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Respuesta al preflight OPTIONS. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

/** Igual que Response.json pero adjuntando los headers CORS. */
export function jsonWithCors(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders() });
}

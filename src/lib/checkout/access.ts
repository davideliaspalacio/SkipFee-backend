/**
 * Política de acceso (CORS + público) para los endpoints que consume la tienda
 * web pública (`/pedir`) además del panel admin. Centralizado acá para poder
 * testearlo puro y para que `src/middleware.ts` lo reuse sin duplicar listas.
 *
 * Tres conceptos:
 *  - self-cors: `/api/checkout/*` ya setea sus PROPIOS headers CORS y maneja el
 *    preflight OPTIONS (ver `cors.ts`). El middleware debe dejarlos pasar tal
 *    cual (sin chequear sesión ni pisar/duplicar CORS).
 *  - público: rutas que NO requieren sesión de admin (las llama el bot o la
 *    tienda). El middleware igual les agrega CORS si el origen está permitido.
 *  - orígenes permitidos: localhost del front en dev + `STOREFRONT_ORIGIN` en
 *    producción.
 */

/**
 * Prefijos públicos: cualquier ruta que empiece con uno de estos no pide sesión.
 *
 * Multi-empresa (cambio de matching): los webhooks pasaron a llevar el
 * `<companyId>` en el path (`/api/webhooks/kapso/<companyId>`,
 * `/api/webhooks/wompi/<companyId>`). El prefijo `/api/webhooks/` los cubre a
 * todos por igual, así que no hace falta listar cada empresa. El checkout sigue
 * SIN `<companyId>` en el path (el secreto es el `orderId`; la empresa se
 * resuelve desde el `order`).
 *
 * Las rutas de negocio que antes eran públicas para la tienda
 * (`GET /api/zones`, `GET /api/promotions/active`, `POST /api/quotes`) se movieron
 * bajo `/api/<companyId>/...` y son del PANEL (con `withTenant`). La tienda ya no
 * las consume por HTTP público: el catálogo público va por las rutas públicas con
 * empresa (`/api/products/available?company=<slug>`), y el bot interno no pega a
 * rutas HTTP. Por eso se quitan de la allowlist (ver PUBLIC_METHOD_PATHS abajo).
 */
const PUBLIC_PREFIXES = [
  '/api/health',
  '/api/auth/',
  '/api/webhooks/', // incl. /api/webhooks/{kapso,wompi}/<companyId>
  '/api/wompi/webhook', // legacy: webhook Wompi single-tenant (compat)
  '/api/products/available',
  '/api/cron/',
  '/api/checkout/', // la tienda web (secreto = orderId); CORS propio en cada route
  '/api/storefront/', // vitrina pública de un negocio: <slug>.skipfee.co
];

/**
 * Endpoints públicos por (método, ruta exacta). El bot y la tienda los llaman
 * sin sesión de admin. Se usa match EXACTO (no prefijo) para no exponer las
 * rutas hijas.
 *
 * Multi-empresa: `POST /api/orders`, `GET /api/zones`, `GET /api/promotions/active`
 * y `POST /api/quotes` se movieron a `/api/<companyId>/...` (panel, `withTenant`)
 * y dejaron de ser públicos. La creación de pedidos del bot y el catálogo de la
 * tienda viajan ahora scopeados por empresa (checkout / products-available). Solo
 * queda público `POST /api/leads` (plataforma, landing de marketing).
 */
const PUBLIC_METHOD_PATHS: Array<{ method: string; pathname: string }> = [
  // POST /api/leads: la landing (/pre-registro) captura leads de la campaña.
  // Público (sin sesión admin); es de PLATAFORMA (no de empresa). El origen del
  // sitio de marketing debe estar en EXTRA_CORS_ORIGINS para que el middleware
  // le responda CORS.
  { method: 'POST', pathname: '/api/leads' },
  // POST /api/demo-visit: avisa a Discord cuando alguien entra a la demo pública
  // del panel (admin /preview). Sin sesión; el origen del panel va en EXTRA_CORS_ORIGINS.
  { method: 'POST', pathname: '/api/demo-visit' },
];

/** Orígenes locales del front en desarrollo (Vite). */
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/**
 * `/api/checkout/*` gestiona su propio CORS + preflight (cors.ts). El middleware
 * las deja pasar sin tocar headers ni exigir sesión.
 */
export function isStorefrontSelfCors(pathname: string): boolean {
  return pathname === '/api/checkout' || pathname.startsWith('/api/checkout/');
}

/** True si la ruta+método no requiere sesión de admin. */
export function isPublicPath(pathname: string, method: string): boolean {
  if (PUBLIC_PREFIXES.some(p => pathname === p || pathname.startsWith(p))) return true;
  return PUBLIC_METHOD_PATHS.some(r => r.method === method && r.pathname === pathname);
}

/**
 * Orígenes a los que respondemos CORS. Incluye los de dev, `STOREFRONT_ORIGIN`
 * (dominio de la tienda) y `EXTRA_CORS_ORIGINS` (lista separada por comas, p.ej.
 * para probar el panel local contra el backend desplegado, u otros dominios).
 * Se lee de env en cada llamada (no se cachea) para no fijarlo en build.
 */
export function allowedOrigins(): string[] {
  const fromEnv = [
    process.env.STOREFRONT_ORIGIN,
    ...(process.env.EXTRA_CORS_ORIGINS ?? '').split(','),
  ]
    .map(o => o?.trim())
    .filter((o): o is string => !!o);
  return [...new Set([...DEV_ORIGINS, ...fromEnv])];
}

/** True si el `Origin` del request está en la lista de permitidos. */
export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (allowedOrigins().includes(origin)) return true;
  return esSubdominioDeTienda(origin);
}

/**
 * Dominios de negocio: `https://arepas.skipfee.co`.
 *
 * Cada restaurante tiene su propia dirección, así que la lista fija de orígenes
 * no sirve — no se puede enumerar algo que crece cada vez que alguien se
 * registra. Se acepta cualquier subdominio de un nivel sobre las raíces de
 * `STOREFRONT_WILDCARD_ROOTS` (por defecto skipfee.co).
 *
 * Tres cuidados, porque esto relaja CORS:
 *   - Solo https, para que no entre un `http://` suplantando.
 *   - Solo UN nivel: `algo.arepas.skipfee.co` no pasa.
 *   - Coincidencia por sufijo con el punto incluido, así `noskipfee.co` no
 *     cuela por terminar en las mismas letras.
 */
export function esSubdominioDeTienda(origin: string): boolean {
  let host: string;
  let protocolo: string;
  try {
    const url = new URL(origin);
    host = url.hostname.toLowerCase();
    protocolo = url.protocol;
  } catch {
    return false;
  }
  if (protocolo !== 'https:') return false;

  const raices = (process.env.STOREFRONT_WILDCARD_ROOTS ?? 'skipfee.co')
    .split(',')
    .map(r => r.trim().toLowerCase())
    .filter(Boolean);

  return raices.some(raiz => {
    if (!host.endsWith(`.${raiz}`)) return false;
    const prefijo = host.slice(0, -(raiz.length + 1));
    return prefijo.length > 0 && !prefijo.includes('.');
  });
}

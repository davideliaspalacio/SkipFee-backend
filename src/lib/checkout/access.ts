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

/** Prefijos públicos: cualquier ruta que empiece con uno de estos no pide sesión. */
const PUBLIC_PREFIXES = [
  '/api/health',
  '/api/auth/',
  '/api/webhooks/',
  '/api/wompi/webhook',
  '/api/products/available',
  '/api/cron/',
  '/api/checkout/', // la tienda web (secreto = orderId); CORS propio en cada route
];

/**
 * Endpoints públicos por (método, ruta exacta). El bot y la tienda los llaman
 * sin sesión de admin. Se usa match EXACTO (no prefijo) para no exponer las
 * rutas hijas: `GET /api/zones` es público pero `PATCH /api/zones/:id` (admin) no.
 */
const PUBLIC_METHOD_PATHS: Array<{ method: string; pathname: string }> = [
  { method: 'POST', pathname: '/api/orders' }, // el bot crea pedido para el cliente
  { method: 'POST', pathname: '/api/quotes' }, // el bot cotiza
  { method: 'GET', pathname: '/api/zones' },    // la tienda lista zonas
  // GET /api/promotions/active: lo consume la tienda web (PromoActiveCard
  // arriba del catálogo + lista del OrderPanel + badges en cada ProductCard).
  // Solo devuelve promos activas vigentes AHORA — el CRUD /api/promotions
  // (POST/PATCH/DELETE y GET completo) sigue privado.
  { method: 'GET', pathname: '/api/promotions/active' },
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
 * Orígenes a los que respondemos CORS. Incluye los de dev y, si está
 * configurado, `STOREFRONT_ORIGIN` (el dominio de la tienda en producción).
 * Se lee de env en cada llamada (no se cachea) para no fijarlo en build.
 */
export function allowedOrigins(): string[] {
  const storefront = process.env.STOREFRONT_ORIGIN?.trim();
  if (storefront && !DEV_ORIGINS.includes(storefront)) {
    return [...DEV_ORIGINS, storefront];
  }
  return [...DEV_ORIGINS];
}

/** True si el `Origin` del request está en la lista de permitidos. */
export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return allowedOrigins().includes(origin);
}

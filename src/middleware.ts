import { NextResponse, type NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { isAllowedOrigin, isPublicPath, isStorefrontSelfCors } from '@/lib/checkout/access';

/**
 * Middleware que (a) habilita CORS para el frontend en otro origen y
 * (b) protege todas las rutas /api/* salvo las explícitamente públicas.
 *
 * CORS:
 * - El panel admin (Vite :5173) hace fetch al backend (:3000). Para que las
 *   cookies HTTP-only viajen cross-origin respondemos
 *   Access-Control-Allow-Credentials: true y devolvemos el Origin tal cual
 *   (nunca '*' porque no es compatible con credentials).
 * - Manejamos el preflight OPTIONS automáticamente.
 * - Los orígenes permitidos salen de `allowedOrigins()` (dev + STOREFRONT_ORIGIN).
 *
 * Tienda web (`/pedir`):
 * - Las rutas `/api/checkout/*` setean su PROPIO CORS (origen = STOREFRONT_ORIGIN,
 *   sin credentials) y manejan su preflight OPTIONS. El middleware las deja pasar
 *   intactas (sin sesión, sin pisar headers) vía `isStorefrontSelfCors`.
 * - `/api/products/available?company=<slug>` es pública (catálogo de la tienda por
 *   empresa) y recibe CORS del middleware (ver `@/lib/checkout/access`).
 *
 * Multi-empresa:
 * - El árbol de negocio vive bajo `/api/<companyId>/*` (orders, chats, products,
 *   zones, …). Esas rutas son PRIVADAS: el middleware solo exige sesión (igual que
 *   hoy); la autorización fina (pertenencia a la empresa del path) la hace
 *   `withTenant`/`getTenantContext` en cada handler. No hay matching especial aquí.
 * - Las rutas de plataforma `/api/platform/*` (owner) también son privadas: pasan
 *   el gate de sesión y `requirePlatformAdmin` valida que sea owner en el handler.
 * - Rutas públicas reconocidas (sin sesión): webhooks
 *   `/api/webhooks/{kapso,wompi}/<companyId>`, `/api/checkout/*`,
 *   `/api/products/available`, `/api/leads`, `/api/health`, `/api/auth/*`,
 *   `/api/cron/*` (ver `isPublicPath` en `@/lib/checkout/access`).
 */

function corsHeaders(origin: string | null): Record<string, string> {
  if (!isAllowedOrigin(origin) || !origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const origin = request.headers.get('origin');

  // /api/checkout/*: las rutas gestionan su propio CORS + preflight OPTIONS y son
  // públicas (el secreto es el orderId). Pasar sin tocar headers ni sesión.
  if (isStorefrontSelfCors(pathname)) {
    return NextResponse.next();
  }

  const cors = corsHeaders(origin);

  // Preflight CORS
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: cors });
  }

  // Rutas públicas: pasar sin chequeo de sesión
  if (isPublicPath(pathname, request.method)) {
    const res = NextResponse.next();
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }

  // Rutas privadas: validar sesión
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json(
      { ok: false, error: 'No autenticado' },
      { status: 401, headers: cors },
    );
  }

  const res = NextResponse.next();
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
}

export const config = {
  matcher: '/api/:path*',
  runtime: 'nodejs',
};

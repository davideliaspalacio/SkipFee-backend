import { NextResponse, type NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth';

/**
 * Middleware que (a) habilita CORS para el frontend en otro origen y
 * (b) protege todas las rutas /api/* salvo las explícitamente públicas.
 *
 * CORS:
 * - El frontend Vite vive en :5173 y hace fetch al backend en :3000.
 * - Para que las cookies HTTP-only viajen cross-origin, respondemos
 *   Access-Control-Allow-Credentials: true y devolvemos el Origin tal cual
 *   (nunca '*' porque no es compatible con credentials).
 * - Manejamos el preflight OPTIONS automáticamente.
 *
 * Rutas públicas:
 * - /api/health                  — healthcheck
 * - /api/auth/*                  — login, logout, me
 * - /api/webhooks/*              — Kapso valida con HMAC
 * - /api/wompi/webhook           — Wompi valida con checksum
 * - /api/products/available      — la consume el bot
 */

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  // Agregar dominios de producción acá cuando despleguemos.
];

const PUBLIC_PREFIXES = [
  '/api/health',
  '/api/auth/',
  '/api/webhooks/',
  '/api/wompi/webhook',
  '/api/products/available',
  '/api/cron/',
];

/**
 * Endpoints públicos por método. El bot de WhatsApp llama estos desde el
 * propio backend (en handlers de Kapso) y no tiene sesión de admin.
 *
 * El rate limit por número de teléfono vive dentro de cada handler.
 */
const PUBLIC_METHOD_PATHS: Array<{ method: string; pathname: string }> = [
  { method: 'POST', pathname: '/api/orders' },   // bot crea pedido para el cliente
  { method: 'POST', pathname: '/api/quotes' },   // bot cotiza
];

function isPublic(pathname: string, method: string): boolean {
  if (PUBLIC_PREFIXES.some(p => pathname === p || pathname.startsWith(p))) return true;
  return PUBLIC_METHOD_PATHS.some(
    r => r.method === method && r.pathname === pathname,
  );
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const origin = request.headers.get('origin');
  const cors = corsHeaders(origin);

  // Preflight CORS
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: cors });
  }

  // Rutas públicas: pasar sin chequeo de sesión
  if (isPublic(pathname, request.method)) {
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

import { NextResponse, type NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth';

/**
 * Middleware que protege todas las rutas /api/* salvo las explícitamente
 * públicas. Si no hay sesión válida → 401.
 *
 * Rutas públicas:
 * - /api/health                  — healthcheck
 * - /api/auth/*                  — login, logout, me (cada uno maneja su propia 401)
 * - /api/webhooks/kapso          — Kapso valida con HMAC; no requiere cookie
 * - /api/wompi/webhook           — Wompi valida con su checksum
 * - /api/products/available      — la consume el bot (sin sesión)
 */
const PUBLIC_PREFIXES = [
  '/api/health',
  '/api/auth/',
  '/api/webhooks/',
  '/api/wompi/webhook',
  '/api/products/available',
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(p => pathname === p || pathname.startsWith(p));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ ok: false, error: 'No autenticado' }, { status: 401 });
  }

  // Si el middleware refrescó tokens, los propagamos en la respuesta
  // que armarán los handlers downstream. Como NextResponse.next() no expone
  // un buen mecanismo para esto en Edge runtime, lo dejamos para que cada
  // request "vieja" use el refresh hasta que /api/auth/me explícitamente
  // re-setea las cookies (el frontend lo llama al cargar).
  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
  runtime: 'nodejs',
};

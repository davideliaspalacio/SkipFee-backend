import type { NextRequest } from 'next/server';
import { createClient, type User } from '@supabase/supabase-js';
import { env } from './env';

/**
 * Auth helpers: usamos Supabase Auth como engine, pero el frontend NO toca
 * el SDK de Supabase. Toda la sesión vive en una cookie HTTP-only que se
 * setea desde /api/auth/login y se valida en el middleware.
 *
 * Por qué cookies HTTP-only:
 * - El frontend Vite no puede leerlas con JS → reduce surface de XSS
 * - El polling (fetch /api/*) las manda automáticamente con `credentials: 'include'`
 * - El logout es atómico (server las borra)
 */

export const SESSION_COOKIE_NAME = 'bs_session';
export const REFRESH_COOKIE_NAME = 'bs_refresh';

interface SessionCookieValue {
  accessToken: string;
  refreshToken: string;
}

/**
 * Cliente Supabase Auth con la publishable key. Lo usamos para signInWithPassword
 * y para validar tokens (getUser). NO bypasea RLS.
 */
export function authClient() {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Construye los strings Set-Cookie para guardar la sesión. Devolvemos un array
 * porque guardamos access_token y refresh_token en cookies separadas (más fácil
 * de borrar y debuggear que un solo JSON serializado).
 */
export function buildSessionCookies(opts: SessionCookieValue): string[] {
  const isProd = env.NODE_ENV === 'production';
  // SameSite=None permite que las cookies viajen cross-origin (frontend
  // en :5173 → backend en :3000, o frontend en otro dominio en prod).
  // En localhost los browsers aceptan SameSite=None sin Secure; en prod
  // sí exige HTTPS y agregamos Secure automáticamente.
  const access = serializeCookie(SESSION_COOKIE_NAME, opts.accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'none',
    path: '/',
    maxAge: 60 * 60, // 1h
  });
  const refresh = serializeCookie(REFRESH_COOKIE_NAME, opts.refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'none',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30d
  });
  return [access, refresh];
}

/**
 * Strings Set-Cookie para borrar la sesión (Max-Age=0).
 */
export function buildClearCookies(): string[] {
  return [
    serializeCookie(SESSION_COOKIE_NAME, '', { path: '/', maxAge: 0 }),
    serializeCookie(REFRESH_COOKIE_NAME, '', { path: '/', maxAge: 0 }),
  ];
}

interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  path?: string;
  maxAge?: number;
}

function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.sameSite) parts.push(`SameSite=${cap(opts.sameSite)}`);
  if (opts.secure) parts.push('Secure');
  if (opts.httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Lee el access_token de la cookie del request y valida con Supabase.
 * Devuelve el usuario o null. Usado por el middleware y por /api/auth/me.
 *
 * Si el access_token está vencido pero hay refresh_token, intenta refrescar
 * y devolver el nuevo par de tokens (que el caller debe re-setear en cookies).
 */
export async function getSessionUser(
  request: NextRequest,
): Promise<{ user: User; refreshedTokens?: SessionCookieValue } | null> {
  // Aceptamos el token en 3 formas (en orden de preferencia):
  //  1. Header Authorization: Bearer <token>  ← lo usa el frontend cross-origin
  //  2. Cookie bs_session                     ← same-origin (proxy o prod)
  //  3. Refresh con cookie bs_refresh         ← fallback si access vencido
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : null;
  const accessToken = bearerToken ?? request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const refreshToken = request.cookies.get(REFRESH_COOKIE_NAME)?.value;

  const supabase = authClient();

  if (accessToken) {
    const { data, error } = await supabase.auth.getUser(accessToken);
    if (!error && data.user) return { user: data.user };
  }

  // Access token vencido o inválido → intentar refresh
  if (refreshToken) {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (!error && data.session && data.user) {
      return {
        user: data.user,
        refreshedTokens: {
          accessToken: data.session.access_token,
          refreshToken: data.session.refresh_token,
        },
      };
    }
  }

  return null;
}

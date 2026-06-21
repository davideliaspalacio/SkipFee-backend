import type { NextRequest } from 'next/server';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { getSessionUser, SESSION_COOKIE_NAME } from './auth';
import { supabaseAdmin, supabaseForUser } from './db';

/**
 * Resolución de tenant (empresa) para las rutas multi-empresa.
 *
 * El `companyId` del path `/api/<companyId>/...` es el **slug** de la empresa
 * (identificador público y legible). Aquí lo resolvemos a la empresa real,
 * verificamos que el usuario autenticado tenga acceso, y devolvemos un contexto
 * con:
 *   - `company` (id uuid + slug),
 *   - `role` del usuario en la empresa (o 'platform' si es owner SkipFee),
 *   - `db`: cliente Supabase con el **JWT del usuario** → RLS activa (2ª capa
 *     de aislamiento). Las queries de negocio van por este cliente, no por
 *     service_role.
 *
 * Aislamiento en dos capas: las rutas SIEMPRE filtran por `ctx.company.id` en
 * código (capa 1) y la RLS de pertenencia respalda a nivel BD (capa 2).
 */

export type CompanyRole = 'super_admin' | 'admin' | 'cocina' | 'empaque';

export interface TenantContext {
  user: User;
  accessToken: string;
  company: { id: string; slug: string };
  /** Rol del usuario en la empresa, o 'platform' si es owner SkipFee. */
  role: CompanyRole | 'platform';
  isPlatformAdmin: boolean;
  /** Cliente Supabase scopeado al usuario (respeta RLS). Úsalo para negocio. */
  db: SupabaseClient;
}

export interface TenantError {
  error: string;
  status: number;
}

function extractAccessToken(request: NextRequest): string | null {
  const authHeader = request.headers.get('authorization');
  const bearer = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : null;
  return bearer ?? request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}

/**
 * Valida sesión + pertenencia a la empresa del path. Devuelve el contexto o un
 * error tipado (sin lanzar). Usar directamente en handlers, o vía `withTenant`.
 */
export async function getTenantContext(
  request: NextRequest,
  companySlug: string,
): Promise<{ ctx: TenantContext } | TenantError> {
  const session = await getSessionUser(request);
  if (!session) return { error: 'No autenticado', status: 401 };

  // Si el access token venía vencido, getSessionUser lo refrescó: usa el nuevo.
  const accessToken = session.refreshedTokens?.accessToken ?? extractAccessToken(request);
  if (!accessToken) return { error: 'No autenticado', status: 401 };

  const admin = supabaseAdmin();

  // 1) Resolver la empresa por slug.
  const { data: company } = await admin
    .from('companies')
    .select('id, slug, status')
    .eq('slug', companySlug)
    .maybeSingle();

  if (!company) return { error: 'Empresa no encontrada', status: 404 };
  if (company.status === 'suspended') return { error: 'Empresa suspendida', status: 403 };

  // 2) ¿Owner plataforma? (puede operar sobre cualquier empresa)
  const { data: platformRow } = await admin
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', session.user.id)
    .maybeSingle();
  const isPlatformAdmin = !!platformRow;

  // 3) Resolver rol del usuario en la empresa.
  let role: CompanyRole | 'platform';
  if (isPlatformAdmin) {
    role = 'platform';
  } else {
    const { data: member } = await admin
      .from('company_members')
      .select('role')
      .eq('user_id', session.user.id)
      .eq('company_id', company.id)
      .maybeSingle();
    if (!member) return { error: 'Sin acceso a esta empresa', status: 403 };
    role = member.role as CompanyRole;
  }

  return {
    ctx: {
      user: session.user,
      accessToken,
      company: { id: company.id, slug: company.slug },
      role,
      isPlatformAdmin,
      db: supabaseForUser(accessToken),
    },
  };
}

/**
 * Envuelve un route handler de negocio: resuelve el tenant del path
 * `/api/<companyId>/...`, corta con 401/403/404 si no procede, y entrega el
 * `ctx` ya validado más los `params` de la ruta.
 *
 * Uso:
 *   export const GET = withTenant(async (req, ctx, params) => {
 *     const { data } = await ctx.db.from('orders')
 *       .select('*').eq('company_id', ctx.company.id);   // capa 1 (+ RLS = capa 2)
 *     return Response.json({ ok: true, orders: data });
 *   });
 */
/**
 * Resultado de validar al owner plataforma (`platform_admins`).
 */
export interface PlatformAdminContext {
  user: User;
  accessToken: string;
}

/**
 * Exige que el request venga de un owner plataforma (fila en `platform_admins`).
 * Para las rutas `/api/platform/*` (crear/listar empresas). NO usa el tenant del
 * path: aquí no hay `<companyId>`, solo sesión + chequeo de plataforma.
 *
 * Devuelve el contexto o un error tipado (sin lanzar). Usa `supabaseAdmin()`
 * para leer `platform_admins` (tabla sin policy pública).
 */
export async function requirePlatformAdmin(
  request: NextRequest,
): Promise<{ ctx: PlatformAdminContext } | TenantError> {
  const session = await getSessionUser(request);
  if (!session) return { error: 'No autenticado', status: 401 };

  const accessToken = session.refreshedTokens?.accessToken ?? extractAccessToken(request);
  if (!accessToken) return { error: 'No autenticado', status: 401 };

  const { data: platformRow } = await supabaseAdmin()
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (!platformRow) return { error: 'Solo el owner de la plataforma', status: 403 };

  return { ctx: { user: session.user, accessToken } };
}

export function withTenant<P extends { companyId: string }>(
  handler: (
    request: NextRequest,
    ctx: TenantContext,
    params: P,
  ) => Promise<Response> | Response,
) {
  return async (request: NextRequest, context: { params: Promise<P> }) => {
    const params = await context.params;
    const result = await getTenantContext(request, params.companyId);
    if ('error' in result) {
      return Response.json({ ok: false, error: result.error }, { status: result.status });
    }
    return handler(request, result.ctx, params);
  };
}

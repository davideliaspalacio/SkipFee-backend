import type { NextRequest } from 'next/server';
import { buildSessionCookies, getSessionUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/me
 *
 * Contrato multi-empresa que consume el panel admin:
 *   { ok, user,
 *     memberships: [{ companyCode, companySlug, companyName, role }],
 *     activeCompanyCode, activeCompanySlug }
 *
 * - `memberships`: las empresas del usuario (vía `company_members` ⨝ `companies`).
 *   Si el usuario es owner plataforma (`platform_admins`), devolvemos TODAS las
 *   empresas con rol `platform` para que pueda operar sobre cualquiera.
 * - `companyCode`: identificador NUMÉRICO de la empresa que viaja en la ruta
 *   `/api/<code>/...`. `companySlug` se conserva solo para display/logs.
 * - `activeCompanyCode` / `activeCompanySlug`: la primera membresía (o la única).
 *   El panel fija el code como empresa activa tras el login; el owner puede
 *   cambiarla con su selector. El slug queda para mostrar.
 *
 * Si el access_token estaba vencido y se refrescó con el refresh_token,
 * actualiza las cookies en la respuesta.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return Response.json({ ok: false, error: 'No autenticado' }, { status: 401 });
  }

  const headers: Array<[string, string]> = [['Content-Type', 'application/json']];
  if (session.refreshedTokens) {
    for (const c of buildSessionCookies(session.refreshedTokens)) {
      headers.push(['Set-Cookie', c]);
    }
  }

  const admin = supabaseAdmin();

  // ¿Owner plataforma? Lee con service_role (platform_admins no tiene policy pública).
  const { data: platformRow } = await admin
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', session.user.id)
    .maybeSingle();
  const isPlatformAdmin = !!platformRow;

  type Membership = {
    companyCode: number;
    companySlug: string;
    companyName: string;
    role: string;
  };
  let memberships: Membership[] = [];

  if (isPlatformAdmin) {
    // El owner ve todas las empresas (rol 'platform' sobre cada una).
    const { data: companies } = await admin
      .from('companies')
      .select('code, slug, name')
      .order('name');
    memberships = (companies ?? []).map(c => ({
      companyCode: c.code as number,
      companySlug: c.slug as string,
      companyName: c.name as string,
      role: 'platform',
    }));
  } else {
    // Membresías del usuario: company_members ⨝ companies.
    const { data: rows } = await admin
      .from('company_members')
      .select('role, companies(code, slug, name)')
      .eq('user_id', session.user.id);
    memberships = (rows ?? [])
      .map(r => {
        const company = r.companies as unknown as {
          code: number;
          slug: string;
          name: string;
        } | null;
        if (!company) return null;
        return {
          companyCode: company.code,
          companySlug: company.slug,
          companyName: company.name,
          role: r.role as string,
        };
      })
      .filter((m): m is Membership => m !== null);
  }

  const activeCompanyCode = memberships[0]?.companyCode ?? null;
  const activeCompanySlug = memberships[0]?.companySlug ?? null;

  return new Response(
    JSON.stringify({
      ok: true,
      user: {
        id: session.user.id,
        email: session.user.email,
        role: (session.user.app_metadata as { role?: string } | undefined)?.role ?? null,
        isPlatformAdmin,
      },
      memberships,
      activeCompanyCode,
      activeCompanySlug,
    }),
    { status: 200, headers },
  );
}

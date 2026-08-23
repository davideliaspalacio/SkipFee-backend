import type { NextRequest } from 'next/server';
import { buildSessionCookies, getSessionUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/db';
import { diasRestantes } from '@/lib/trial';
import { mapEvolutionState } from '@/lib/whatsapp/evolution/parse';

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
    /** Suscripción de esa empresa: el panel avisa los días que quedan de prueba. */
    plan: string;
    status: string;
    trialEndsAt: string | null;
    diasRestantes: number | null;
    /** null = nunca estuvo operativo (sigue en el onboarding). */
    operativoDesde: string | null;
    /** Estado del canal de WhatsApp. Solo se usa para alertar si ya operaba. */
    whatsapp: 'connected' | 'connecting' | 'disconnected' | 'unknown' | null;
  };
  let memberships: Membership[] = [];

  // Las columnas de suscripción llegan con la migración 0053. Si la BD todavía
  // no la tiene, PostgREST responde 42703 y el SELECT entero falla: sin este
  // fallback, una migración pendiente deja a TODO el panel sin membresías (=
  // sin navegación) en vez de solo sin el aviso de prueba.
  // `company_integrations` viaja embebido: es el único dato que falta para que
  // el panel pueda avisar "tu WhatsApp está caído" en cualquier pantalla sin
  // una consulta extra por render.
  const COLUMNAS_CON_PLAN =
    'code, slug, name, status, plan, trial_ends_at, operativo_desde, ' +
    'company_integrations(whatsapp_provider, evolution_session_state)';
  const COLUMNAS_BASE = 'code, slug, name, status';

  type Integraciones = { whatsapp_provider?: string | null; evolution_session_state?: string | null };
  type FilaEmpresa = {
    code: number;
    slug: string;
    name: string;
    status: string | null;
    plan?: string | null;
    trial_ends_at?: string | null;
    operativo_desde?: string | null;
    company_integrations?: Integraciones | Integraciones[] | null;
  };

  /**
   * Estado del canal, solo para Evolution. Kapso no tiene sesión que se caiga:
   * si su número está verificado, sigue vivo, así que devolver un estado ahí
   * sería inventar una alarma que no existe.
   */
  const estadoWhatsApp = (c: FilaEmpresa): Membership['whatsapp'] => {
    const raw = c.company_integrations;
    const fila = (Array.isArray(raw) ? raw[0] : raw) ?? null;
    if (!fila || fila.whatsapp_provider !== 'evolution') return null;
    return mapEvolutionState(fila.evolution_session_state);
  };

  if (isPlatformAdmin) {
    // El owner ve todas las empresas (rol 'platform' sobre cada una).
    const conPlan = await admin.from('companies').select(COLUMNAS_CON_PLAN).order('name');
    const companies: FilaEmpresa[] | null = conPlan.error
      ? ((await admin.from('companies').select(COLUMNAS_BASE).order('name'))
          .data as unknown as FilaEmpresa[] | null)
      : (conPlan.data as unknown as FilaEmpresa[] | null);
    memberships = (companies ?? []).map(c => ({
      companyCode: c.code as number,
      companySlug: c.slug as string,
      companyName: c.name as string,
      role: 'platform',
      plan: c.plan ?? 'cortesia',
      status: c.status ?? 'active',
      trialEndsAt: c.trial_ends_at ?? null,
      diasRestantes: diasRestantes(c.trial_ends_at ?? null),
      operativoDesde: c.operativo_desde ?? null,
      whatsapp: estadoWhatsApp(c),
    }));
  } else {
    // Membresías del usuario: company_members ⨝ companies.
    type FilaMembresia = { role: string; companies: unknown };
    const conPlan = await admin
      .from('company_members')
      .select(`role, companies(${COLUMNAS_CON_PLAN})`)
      .eq('user_id', session.user.id);
    const rows: FilaMembresia[] | null = conPlan.error
      ? ((
          await admin
            .from('company_members')
            .select(`role, companies(${COLUMNAS_BASE})`)
            .eq('user_id', session.user.id)
        ).data as FilaMembresia[] | null)
      : (conPlan.data as FilaMembresia[] | null);
    memberships = (rows ?? [])
      .map(r => {
        const company = r.companies as unknown as FilaEmpresa | null;
        if (!company) return null;
        return {
          companyCode: company.code,
          companySlug: company.slug,
          companyName: company.name,
          role: r.role as string,
          plan: company.plan ?? 'cortesia',
          status: company.status ?? 'active',
          trialEndsAt: company.trial_ends_at ?? null,
          diasRestantes: diasRestantes(company.trial_ends_at ?? null),
          operativoDesde: company.operativo_desde ?? null,
          whatsapp: estadoWhatsApp(company),
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

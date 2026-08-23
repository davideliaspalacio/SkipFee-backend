import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { requirePlatformAdmin } from '@/lib/tenant';
import { provisionCompany } from '@/lib/provisioning';
import { diasRestantes } from '@/lib/trial';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/platform/companies — gestión de empresas por el OWNER de la plataforma.
 *
 * Estas rutas NO viven bajo `[companyId]` (no son de una empresa): son de la
 * capa plataforma. Se protegen con `requirePlatformAdmin` (sesión + fila en
 * `platform_admins`), no con `withTenant`. Todo se hace con `supabaseAdmin()`
 * (service_role): crear empresa, su primer super_admin, integraciones y settings
 * tocan tablas sensibles / sin policy de cliente.
 */

const slugRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const createSchema = z
  .object({
    slug: z
      .string()
      .min(2)
      .max(63)
      .regex(slugRe, 'slug: minúsculas, números y guiones (ej: bros-and-subs)'),
    name: z.string().min(1).max(120),
    // Primer super_admin de la empresa: por user_id existente o por email
    // (en cuyo caso se crea/invita vía Supabase Auth admin).
    superAdminUserId: z.string().uuid().optional(),
    superAdminEmail: z.string().email().optional(),
    // P0 onboarding/test: permite crear un usuario que pueda iniciar sesión de
    // inmediato. Si el email ya existe, NO reseteamos su contraseña.
    superAdminPassword: z.string().min(8).max(72).optional(),
  })
  .refine(d => d.superAdminUserId || d.superAdminEmail, {
    message: 'Indica superAdminUserId o superAdminEmail',
    path: ['superAdminUserId'],
  });

/**
 * GET /api/platform/companies — lista todas las empresas (solo owner).
 */
export async function GET(request: NextRequest) {
  const auth = await requirePlatformAdmin(request);
  if ('error' in auth) {
    return Response.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  // Las columnas de suscripción llegan con la 0053. Con la migración pendiente,
  // PostgREST falla el SELECT entero: sin este fallback la pantalla "Empresas"
  // se queda cargando para siempre en vez de perderse solo la columna nueva.
  const BASE = 'id, code, slug, name, status, next_order_number, created_at';
  const CON_PLAN = `${BASE}, plan, trial_started_at, trial_ends_at`;

  const sb = supabaseAdmin();
  const conPlan = await sb
    .from('companies')
    .select(CON_PLAN)
    .order('created_at', { ascending: false });

  if (conPlan.error) {
    console.warn('[platform/companies] sin columnas de plan (¿falta la 0053?):', conPlan.error.message);
  }

  const res = conPlan.error
    ? await sb.from('companies').select(BASE).order('created_at', { ascending: false })
    : conPlan;

  if (res.error) {
    console.error('[platform/companies] list error', res.error);
    return Response.json({ ok: false, error: res.error.message }, { status: 500 });
  }

  const data = res.data as Array<Record<string, unknown>> | null;

  // `diasRestantes` se calcula aquí y no en el panel: la fuente de la verdad
  // sobre cuánto queda de prueba es el reloj del servidor, no el del navegador.
  const companies = (data ?? []).map(fila => {
    const c = fila as Record<string, unknown>;
    const fin = (c.trial_ends_at as string | null | undefined) ?? null;
    return {
      ...c,
      plan: (c.plan as string | undefined) ?? 'cortesia',
      trial_started_at: (c.trial_started_at as string | null | undefined) ?? null,
      trial_ends_at: fin,
      diasRestantes: diasRestantes(fin),
    };
  });

  return Response.json({ ok: true, companies });
}

/**
 * POST /api/platform/companies — crea una empresa + su primer super_admin +
 * filas vacías de `company_integrations` y `settings` por defecto.
 *
 * Body: { slug, name, superAdminUserId? , superAdminEmail? }
 *  - Si llega `superAdminUserId`, se usa ese usuario auth existente.
 *  - Si llega `superAdminEmail`, se busca/crea el usuario vía Supabase Auth admin
 *    (invitación implícita: queda confirmado y la empresa puede operar; el
 *    usuario establece su contraseña con el flujo de recuperación).
 */
export async function POST(request: NextRequest) {
  const auth = await requirePlatformAdmin(request);
  if ('error' in auth) {
    return Response.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  let body;
  try {
    body = createSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  // El alta la hace `lib/provisioning.ts`, el mismo motor que usará el registro
  // público. Antes esta lógica vivía acá dentro, atada a `requirePlatformAdmin`,
  // y habría obligado a una segunda implementación para el autoservicio.
  //
  // `requireEmailConfirmation: false` porque es el owner quien crea la cuenta y
  // entrega las credenciales: el correo ya está validado fuera del sistema.
  const result = await provisionCompany({
    slug: body.slug,
    name: body.name,
    superAdminUserId: body.superAdminUserId,
    superAdminEmail: body.superAdminEmail,
    superAdminPassword: body.superAdminPassword,
    requireEmailConfirmation: false,
  });

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: result.status });
  }

  return Response.json(
    { ok: true, company: result.company, superAdmin: result.superAdmin },
    { status: 201 },
  );
}

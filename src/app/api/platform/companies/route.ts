import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { requirePlatformAdmin } from '@/lib/tenant';

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

  const { data, error } = await supabaseAdmin()
    .from('companies')
    .select('id, code, slug, name, status, next_order_number, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[platform/companies] list error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true, companies: data ?? [] });
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

  const admin = supabaseAdmin();

  // 0) slug único: cortar temprano con 409 antes de tocar Auth.
  const { data: existing } = await admin
    .from('companies')
    .select('id')
    .eq('slug', body.slug)
    .maybeSingle();
  if (existing) {
    return Response.json({ ok: false, error: 'El slug ya existe' }, { status: 409 });
  }

  // 1) Resolver el user_id del primer super_admin (existente o creado por email).
  let superAdminUserId = body.superAdminUserId ?? null;
  if (!superAdminUserId && body.superAdminEmail) {
    const email = body.superAdminEmail;
    // Crear el usuario en Supabase Auth. Si ya existe, lo recuperamos.
    const { data: created, error: createErr } =
      await admin.auth.admin.createUser({ email, email_confirm: true });

    if (created?.user) {
      superAdminUserId = created.user.id;
    } else {
      // Email ya registrado u otro fallo: intentar localizar al usuario por email.
      const found = await findAuthUserByEmail(email);
      if (found) {
        superAdminUserId = found;
      } else {
        console.error('[platform/companies] createUser error', createErr);
        return Response.json(
          { ok: false, error: 'No se pudo crear/ubicar el usuario super_admin' },
          { status: 502 },
        );
      }
    }
  }

  if (!superAdminUserId) {
    return Response.json(
      { ok: false, error: 'No se pudo resolver el super_admin' },
      { status: 400 },
    );
  }

  // 2) Crear la empresa.
  const { data: company, error: companyErr } = await admin
    .from('companies')
    .insert({ slug: body.slug, name: body.name })
    .select('id, code, slug, name, status, next_order_number, created_at')
    .single();

  if (companyErr || !company) {
    console.error('[platform/companies] insert company error', companyErr);
    return Response.json(
      { ok: false, error: companyErr?.message ?? 'No se pudo crear la empresa' },
      { status: 500 },
    );
  }

  const companyId = company.id as string;

  // 3) Primer miembro super_admin + integraciones vacías + settings por defecto.
  //    Si algo falla, revertir la empresa para no dejar tenants huérfanos.
  const cleanup = async () => {
    await admin.from('companies').delete().eq('id', companyId);
  };

  const { error: memberErr } = await admin.from('company_members').insert({
    user_id: superAdminUserId,
    company_id: companyId,
    role: 'super_admin',
  });
  if (memberErr) {
    console.error('[platform/companies] insert member error', memberErr);
    await cleanup();
    return Response.json({ ok: false, error: memberErr.message }, { status: 500 });
  }

  // Fila de integraciones "vacía" (defaults de BD: wompi_mode='mock', resto null).
  const { error: integErr } = await admin
    .from('company_integrations')
    .insert({ company_id: companyId });
  if (integErr) {
    console.error('[platform/companies] insert integrations error', integErr);
    await cleanup();
    return Response.json({ ok: false, error: integErr.message }, { status: 500 });
  }

  // Fila de settings por defecto (el resto de columnas tienen DEFAULT en BD).
  const { error: settingsErr } = await admin
    .from('settings')
    .insert({ company_id: companyId });
  if (settingsErr) {
    console.error('[platform/companies] insert settings error', settingsErr);
    await cleanup();
    return Response.json({ ok: false, error: settingsErr.message }, { status: 500 });
  }

  return Response.json(
    {
      ok: true,
      company,
      superAdmin: { userId: superAdminUserId },
    },
    { status: 201 },
  );
}

/**
 * Busca un usuario de Auth por email paginando `listUsers` (la API admin no
 * expone búsqueda directa por email). Devuelve el id o null.
 */
async function findAuthUserByEmail(email: string): Promise<string | null> {
  const admin = supabaseAdmin();
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) return null;
    const hit = data.users.find(u => u.email?.toLowerCase() === target);
    if (hit) return hit.id;
    if (data.users.length < 200) return null; // última página
  }
  return null;
}

import { z } from 'zod';
import { withTenant } from '@/lib/tenant';
import { supabaseAdmin } from '@/lib/db';
import { findAuthUserByEmail } from '@/lib/provisioning';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Equipo de la empresa — `/api/<code>/members`
 *
 * Hasta ahora la ÚNICA escritura de `company_members` en todo el backend era la
 * del owner al crear la empresa, así que el `super_admin` inicial no podía
 * agregar a su cocina ni a su empaque: quedaba solo para siempre. Con alta
 * asistida se resolvía pidiéndoselo a Skipfee; con autoservicio no hay a quién
 * pedírselo.
 *
 *   GET    → lista el equipo
 *   POST   → invita a alguien por correo con un rol
 *   DELETE → saca a alguien del equipo
 *
 * Escribe con `service_role`: `company_members` no tiene policy de INSERT para
 * usuarios (ver 0037), así que la autorización la hace este handler.
 */

const ROLES = ['super_admin', 'admin', 'cocina', 'empaque', 'mesero'] as const;

const inviteSchema = z.object({
  email: z.string().email().max(200),
  role: z.enum(ROLES),
  /** Contraseña inicial. Si se omite, el usuario tendrá que recuperarla. */
  password: z.string().min(8).max(72).optional(),
});

const removeSchema = z.object({ userId: z.string().uuid() });

/** Solo quien administra la empresa toca su equipo. */
function canManageTeam(role: string): boolean {
  return role === 'super_admin' || role === 'platform';
}

export const GET = withTenant(async (_request, ctx) => {
  const { data, error } = await supabaseAdmin()
    .from('company_members')
    .select('user_id, role, created_at')
    .eq('company_id', ctx.company.id)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[members GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  // El correo vive en auth.users, que no se puede embeber desde PostgREST.
  const admin = supabaseAdmin();
  const members = await Promise.all(
    (data ?? []).map(async m => {
      const { data: u } = await admin.auth.admin.getUserById(m.user_id as string);
      return {
        userId: m.user_id,
        email: u?.user?.email ?? null,
        role: m.role,
        createdAt: m.created_at,
        isYou: m.user_id === ctx.user.id,
      };
    }),
  );

  return Response.json({ ok: true, members });
});

export const POST = withTenant(async (request, ctx) => {
  if (!canManageTeam(ctx.role)) {
    return Response.json(
      { ok: false, error: 'Solo el dueño de la cuenta puede invitar al equipo' },
      { status: 403 },
    );
  }

  const parsed = inviteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'Body inválido', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { email, role, password } = parsed.data;
  const admin = supabaseAdmin();

  // 1. Usuario de Auth: crear o reutilizar el existente.
  let userId: string | null = null;
  const { data: created } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: email.split('@')[0] },
  });
  if (created?.user) {
    userId = created.user.id;
  } else {
    userId = await findAuthUserByEmail(email);
  }
  if (!userId) {
    return Response.json(
      { ok: false, error: 'No se pudo crear ni ubicar el usuario' },
      { status: 502 },
    );
  }

  // 2. Membresía. Si ya pertenece, se actualiza el rol en vez de fallar: es lo
  //    que el operario espera al "volver a invitar" a alguien con otro cargo.
  const { error } = await admin
    .from('company_members')
    .upsert(
      { user_id: userId, company_id: ctx.company.id, role },
      { onConflict: 'user_id,company_id' },
    );

  if (error) {
    console.error('[members POST] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true, member: { userId, email, role } }, { status: 201 });
});

export const DELETE = withTenant(async (request, ctx) => {
  if (!canManageTeam(ctx.role)) {
    return Response.json(
      { ok: false, error: 'Solo el dueño de la cuenta puede sacar gente del equipo' },
      { status: 403 },
    );
  }

  const parsed = removeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'Falta userId' }, { status: 400 });
  }

  if (parsed.data.userId === ctx.user.id) {
    return Response.json(
      { ok: false, error: 'No puedes sacarte a ti mismo de la empresa' },
      { status: 400 },
    );
  }

  const admin = supabaseAdmin();

  // No dejar la empresa sin ningún super_admin: quedaría sin quien administre
  // el equipo, y recuperarla exigiría intervención de Skipfee.
  const { data: target } = await admin
    .from('company_members')
    .select('role')
    .eq('company_id', ctx.company.id)
    .eq('user_id', parsed.data.userId)
    .maybeSingle();

  if (!target) {
    return Response.json({ ok: false, error: 'Esa persona no está en la empresa' }, { status: 404 });
  }

  if (target.role === 'super_admin') {
    const { count } = await admin
      .from('company_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('company_id', ctx.company.id)
      .eq('role', 'super_admin');
    if ((count ?? 0) <= 1) {
      return Response.json(
        { ok: false, error: 'La empresa quedaría sin dueño. Nombra otro antes de sacar a este.' },
        { status: 409 },
      );
    }
  }

  const { error } = await admin
    .from('company_members')
    .delete()
    .eq('company_id', ctx.company.id)
    .eq('user_id', parsed.data.userId);

  if (error) {
    console.error('[members DELETE] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
});

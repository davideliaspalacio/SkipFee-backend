/**
 * Alta de empresas (tenants) — el motor que comparten el owner y el registro
 * público.
 *
 * Antes esta lógica vivía dentro de `POST /api/platform/companies`, atada a
 * `requirePlatformAdmin`. Extraerla permite que el signup autoservicio use
 * exactamente el mismo camino, en vez de una segunda implementación que se
 * desincronice.
 *
 * El alta tiene dos mitades con propiedades distintas:
 *
 *   1. **El usuario de Supabase Auth** vive fuera de Postgres (Admin API). No
 *      participa de la transacción, así que si el paso 2 falla hay que borrarlo
 *      a mano. Es el único rollback que queda.
 *   2. **Las cuatro filas del tenant** (companies, company_members,
 *      company_integrations, settings) las inserta `provision_company()` en una
 *      sola transacción: o quedan todas, o ninguna. Ver 0051.
 */

import { supabaseAdmin } from '@/lib/db';
import { arrancarTrial } from '@/lib/trial';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Fila de `companies` tal como la devuelve el alta. */
export interface ProvisionedCompany {
  id: string;
  code: number;
  slug: string;
  name: string;
  status: string;
  next_order_number: number;
  created_at: string;
}

export interface ProvisionInput {
  slug: string;
  name: string;
  /** Usuario ya existente que será super_admin. Alternativa a `superAdminEmail`. */
  superAdminUserId?: string;
  /** Se crea (o se reutiliza si ya existe) el usuario de Auth con este correo. */
  superAdminEmail?: string;
  /** Contraseña inicial. Si el correo ya existía, NO se sobrescribe. */
  superAdminPassword?: string;
  /**
   * Si el correo debe confirmarse antes de poder entrar.
   *
   * El owner crea cuentas con `false` (las entrega él, ya validadas). El registro
   * público debe usar `true`: con auto-confirmación cualquiera abriría negocios
   * con correos ajenos.
   */
  requireEmailConfirmation?: boolean;
}

export type ProvisionResult =
  | {
      ok: true;
      company: ProvisionedCompany;
      superAdmin: {
        userId: string;
        email: string | null;
        temporaryPasswordSet: boolean;
        userAlreadyExisted: boolean;
      };
    }
  | { ok: false; error: string; status: number };

// =========================================================================
// Slugs
// =========================================================================

/** Convierte un nombre de negocio en un slug candidato. */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '') // tildes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')          // todo lo demás → guion
    .replace(/^-+|-+$/g, '')              // guiones de borde
    .replace(/-{2,}/g, '-')               // guiones repetidos
    .slice(0, 63);
}

export function isValidSlug(slug: string): boolean {
  return slug.length >= 2 && slug.length <= 63 && SLUG_RE.test(slug);
}

export async function isSlugAvailable(slug: string): Promise<boolean> {
  const { data } = await supabaseAdmin()
    .from('companies')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  return !data;
}

/**
 * Devuelve un slug libre a partir de un nombre. Si el candidato está tomado,
 * prueba `-2`, `-3`… Con alta manual el 409 lo resolvía una persona; con
 * autoservicio tiene que resolverse solo o el registro se traba.
 */
export async function suggestAvailableSlug(name: string): Promise<string | null> {
  const base = slugify(name) || 'negocio';
  if (await isSlugAvailable(base)) return base;
  for (let n = 2; n <= 50; n++) {
    const candidate = `${base.slice(0, 60)}-${n}`;
    if (await isSlugAvailable(candidate)) return candidate;
  }
  return null;
}

// =========================================================================
// Alta
// =========================================================================

/**
 * Busca un usuario de Auth por correo paginando `listUsers` (la Admin API no
 * expone búsqueda directa). Devuelve el id o null.
 */
export async function findAuthUserByEmail(email: string): Promise<string | null> {
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

export async function provisionCompany(input: ProvisionInput): Promise<ProvisionResult> {
  const admin = supabaseAdmin();

  if (!isValidSlug(input.slug)) {
    return { ok: false, error: 'Slug inválido: minúsculas, números y guiones.', status: 400 };
  }
  if (!input.superAdminUserId && !input.superAdminEmail) {
    return { ok: false, error: 'Indica superAdminUserId o superAdminEmail.', status: 400 };
  }

  // Cortar temprano: evita crear un usuario de Auth para un alta que va a fallar.
  if (!(await isSlugAvailable(input.slug))) {
    return { ok: false, error: 'El slug ya existe', status: 409 };
  }

  // ---------------------------------------------------------------------
  // 1. Usuario de Auth (fuera de la transacción)
  // ---------------------------------------------------------------------
  let userId = input.superAdminUserId ?? null;
  let userAlreadyExisted = !!userId;
  let createdAuthUserId: string | null = null;

  if (!userId && input.superAdminEmail) {
    const email = input.superAdminEmail;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: input.superAdminPassword,
      // `email_confirm: true` marca el correo como confirmado SIN verificarlo.
      // Solo es aceptable cuando quien crea la cuenta es el owner.
      email_confirm: !input.requireEmailConfirmation,
      app_metadata: { provider: 'email', providers: ['email'], role: 'super_admin' },
      user_metadata: { name: `${input.name} Admin` },
    });

    if (created?.user) {
      userId = created.user.id;
      createdAuthUserId = created.user.id;
    } else {
      const found = await findAuthUserByEmail(email);
      if (found) {
        userId = found;
        userAlreadyExisted = true;
      } else {
        console.error('[provisioning] createUser error', createErr);
        return { ok: false, error: 'No se pudo crear o ubicar el usuario super_admin', status: 502 };
      }
    }
  }

  if (!userId) {
    return { ok: false, error: 'No se pudo resolver el super_admin', status: 400 };
  }

  // ---------------------------------------------------------------------
  // 2. Las cuatro filas del tenant, atómicas
  // ---------------------------------------------------------------------
  const { data, error } = await admin.rpc('provision_company', {
    p_slug: input.slug,
    p_name: input.name,
    p_user_id: userId,
  });

  if (error || !data) {
    console.error('[provisioning] provision_company error', error);
    // Postgres ya revirtió sus filas; solo queda el usuario de Auth.
    if (createdAuthUserId) {
      await admin.auth.admin.deleteUser(createdAuthUserId).catch(err => {
        console.error('[provisioning] no se pudo revertir el usuario de Auth', err);
      });
    }
    const duplicated = error?.message?.includes('slug ya existe');
    return {
      ok: false,
      error: duplicated ? 'El slug ya existe' : (error?.message ?? 'No se pudo crear la empresa'),
      status: duplicated ? 409 : 500,
    };
  }

  const company = (Array.isArray(data) ? data[0] : data) as ProvisionedCompany;

  // El reloj de la prueba arranca aquí: al registrarse, no al quedar operativo.
  // Va fuera de la transacción a propósito — si falla, la empresa igual quedó
  // creada y el reloj se puede arrancar después desde su ficha; al revés sería
  // perder el alta por una fecha.
  await arrancarTrial(company.id).catch((err: unknown) => {
    console.error('[provisioning] no se pudo arrancar el trial', err);
  });

  return {
    ok: true,
    company,
    superAdmin: {
      userId,
      email: input.superAdminEmail ?? null,
      temporaryPasswordSet: !!input.superAdminPassword && !userAlreadyExisted,
      userAlreadyExisted,
    },
  };
}

/**
 * Emite un pase de un solo uso para entrar al panel sin volver a escribir la
 * contraseña. Lo canjea `POST /api/auth/redeem`.
 *
 * Es el `hashed_token` de un magiclink: `generateLink` lo genera **sin enviar
 * correo**, así que funciona aunque no haya servicio de correo configurado.
 * Devuelve null si falla — el alta no debe romperse porque un atajo no salió;
 * el dueño simplemente entra con su contraseña.
 */
export async function emitirPaseDeEntrada(email: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin().auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (error || !data?.properties?.hashed_token) {
    if (error) console.warn('[provisioning] no se pudo emitir el pase:', error.message);
    return null;
  }
  return data.properties.hashed_token;
}

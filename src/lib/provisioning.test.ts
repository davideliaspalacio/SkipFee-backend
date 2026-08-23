import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- doble de Supabase: Auth admin + rpc + tabla companies ---------------
const authCreated: Array<Record<string, unknown>> = [];
const authDeleted: string[] = [];
let existingSlugs: string[] = [];
let rpcResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let createUserFails = false;

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: (_c: string, slug: string) => ({
          maybeSingle: async () => ({
            data: existingSlugs.includes(slug) ? { id: 'existente' } : null,
          }),
        }),
      }),
    }),
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      authCreated.push({ rpc: args });
      return rpcResult;
    },
    auth: {
      admin: {
        createUser: async (payload: Record<string, unknown>) => {
          if (createUserFails) return { data: null, error: { message: 'ya existe' } };
          authCreated.push(payload);
          return { data: { user: { id: 'user-nuevo' } }, error: null };
        },
        deleteUser: async (id: string) => {
          authDeleted.push(id);
          return { data: null, error: null };
        },
        listUsers: async () => ({ data: { users: [] }, error: null }),
      },
    },
  }),
}));

import { isValidSlug, provisionCompany, slugify, suggestAvailableSlug } from './provisioning';

beforeEach(() => {
  authCreated.length = 0;
  authDeleted.length = 0;
  existingSlugs = [];
  createUserFails = false;
  rpcResult = {
    data: [{ id: 'co-1', code: 1010, slug: 'x', name: 'X', status: 'active', next_order_number: 1, created_at: 'now' }],
    error: null,
  };
});

describe('slugify', () => {
  it('quita tildes, espacios y mayúsculas', () => {
    expect(slugify('Pizzería Napoli')).toBe('pizzeria-napoli');
    expect(slugify('  La  Parrilla del Chef  ')).toBe('la-parrilla-del-chef');
    expect(slugify('Café & Pan')).toBe('cafe-pan');
  });

  it('no deja guiones de borde ni repetidos', () => {
    expect(slugify('!!! Hola !!!')).toBe('hola');
    expect(slugify('a---b')).toBe('a-b');
  });

  it('corta a 63 caracteres', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(63);
  });
});

describe('isValidSlug', () => {
  it('acepta los válidos y rechaza los que no', () => {
    expect(isValidSlug('bros-and-subs')).toBe(true);
    expect(isValidSlug('a')).toBe(false);          // muy corto
    expect(isValidSlug('Con-Mayúsculas')).toBe(false);
    expect(isValidSlug('-empieza-mal')).toBe(false);
    expect(isValidSlug('doble--guion')).toBe(false);
  });
});

describe('suggestAvailableSlug', () => {
  it('devuelve el base si está libre', async () => {
    expect(await suggestAvailableSlug('Pizzería Napoli')).toBe('pizzeria-napoli');
  });

  it('sufija con número si está tomado — el registro no se puede trabar', async () => {
    existingSlugs = ['pizzeria-napoli', 'pizzeria-napoli-2'];
    expect(await suggestAvailableSlug('Pizzería Napoli')).toBe('pizzeria-napoli-3');
  });

  it('cae a un base genérico si el nombre no deja nada usable', async () => {
    expect(await suggestAvailableSlug('!!!')).toBe('negocio');
  });
});

describe('provisionCompany', () => {
  it('crea usuario y empresa, y devuelve ambos', async () => {
    const r = await provisionCompany({
      slug: 'pizzeria-napoli',
      name: 'Pizzería Napoli',
      superAdminEmail: 'dueno@napoli.co',
      superAdminPassword: 'Secreta123',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.company.code).toBe(1010);
    expect(r.superAdmin.userId).toBe('user-nuevo');
    expect(r.superAdmin.temporaryPasswordSet).toBe(true);
  });

  it('corta antes de crear el usuario si el slug está tomado', async () => {
    existingSlugs = ['ocupado'];
    const r = await provisionCompany({
      slug: 'ocupado',
      name: 'X',
      superAdminEmail: 'a@b.co',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    // Lo importante: no se creó basura en Auth.
    expect(authCreated).toHaveLength(0);
  });

  it('revierte el usuario de Auth si el alta en BD falla', async () => {
    rpcResult = { data: null, error: { message: 'boom' } };
    const r = await provisionCompany({
      slug: 'nueva',
      name: 'Nueva',
      superAdminEmail: 'a@b.co',
    });
    expect(r.ok).toBe(false);
    // Postgres revierte sus filas solo; el usuario de Auth lo revertimos nosotros.
    expect(authDeleted).toContain('user-nuevo');
  });

  it('el registro público exige confirmar el correo; el owner no', async () => {
    await provisionCompany({
      slug: 'publica', name: 'P', superAdminEmail: 'a@b.co',
      requireEmailConfirmation: true,
    });
    expect(authCreated[0]).toMatchObject({ email_confirm: false });

    authCreated.length = 0;
    await provisionCompany({
      slug: 'owner', name: 'O', superAdminEmail: 'c@d.co',
      requireEmailConfirmation: false,
    });
    expect(authCreated[0]).toMatchObject({ email_confirm: true });
  });

  it('rechaza un slug inválido sin tocar nada', async () => {
    const r = await provisionCompany({ slug: 'MAL', name: 'X', superAdminEmail: 'a@b.co' });
    expect(r.ok).toBe(false);
    expect(authCreated).toHaveLength(0);
  });

  it('exige un super_admin', async () => {
    const r = await provisionCompany({ slug: 'sin-dueno', name: 'X' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('superAdminUserId');
  });
});

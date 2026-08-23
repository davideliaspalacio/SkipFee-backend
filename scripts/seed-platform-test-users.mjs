import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env.local') });
config({ path: path.join(__dirname, '..', '.env') });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en backend-skipfee/.env.local');
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const users = [
  {
    email: 'platform.owner@skipfee.test',
    password: 'SkipfeePlatform2026!',
    name: 'Owner Plataforma Skipfee',
    appRole: 'platform',
    platform: true,
  },
  {
    email: 'admin.bros@skipfee.test',
    password: 'BrosAdmin2026!',
    name: 'Admin Bros and Subs',
    appRole: 'super_admin',
    memberships: [{ slug: 'bros-and-subs', role: 'super_admin' }],
  },
  {
    email: 'cocina.bros@skipfee.test',
    password: 'BrosCocina2026!',
    name: 'Cocina Bros and Subs',
    appRole: 'cocina',
    memberships: [{ slug: 'bros-and-subs', role: 'cocina' }],
  },
  {
    email: 'empaque.bros@skipfee.test',
    password: 'BrosEmpaque2026!',
    name: 'Empaque Bros and Subs',
    appRole: 'empaque',
    memberships: [{ slug: 'bros-and-subs', role: 'empaque' }],
  },
  {
    email: 'admin.napoli@skipfee.test',
    password: 'NapoliAdmin2026!',
    name: 'Admin Pizzeria Napoli',
    appRole: 'super_admin',
    memberships: [{ slug: 'pizzeria-napoli', role: 'super_admin' }],
  },
];

async function assertTenantSchema() {
  const requiredTables = ['companies', 'company_members', 'platform_admins'];
  const errors = [];

  for (const table of requiredTables) {
    const { error } = await supabase.from(table).select('*').limit(1);
    if (error) errors.push(`${table}: ${error.code ?? 'ERROR'} ${error.message}`);
  }

  if (errors.length > 0) {
    const projectRef = new URL(url).hostname.split('.')[0];
    throw new Error(
      [
        `El proyecto Supabase ${projectRef} no tiene visible el esquema multi-tenant requerido.`,
        'Revisa que backend-skipfee/.env.local apunte al proyecto M2 correcto y que las migraciones 0037+ estén aplicadas.',
        ...errors.map(line => `- ${line}`),
      ].join('\n'),
    );
  }
}

async function findUserByEmail(email) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      throw new Error(
        [
          `Supabase Auth no pudo listar usuarios: ${error.message}`,
          'El seed necesita listUsers para ser idempotente y no duplicar cuentas.',
          'Si el proyecto devuelve "Database error finding users", crea usuarios nuevos con emails únicos',
          'o elimina los usuarios de prueba existentes antes de resembrar.',
        ].join('\n'),
      );
    }
    const hit = data.users.find(user => user.email?.toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function upsertAuthUser(seed) {
  const existing = await findUserByEmail(seed.email);
  const authPayload = {
    password: seed.password,
    email_confirm: true,
    app_metadata: {
      provider: 'email',
      providers: ['email'],
      role: seed.appRole,
    },
    user_metadata: {
      name: seed.name,
      seed: 'platform-admin-p0',
    },
  };

  if (existing) {
    const { data, error } = await supabase.auth.admin.updateUserById(existing.id, authPayload);
    if (error) throw error;
    return data.user;
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email: seed.email,
    ...authPayload,
  });
  if (error) throw error;
  return data.user;
}

async function getCompany(slug) {
  const { data, error } = await supabase
    .from('companies')
    .select('id, code, slug, name')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertPlatformAdmin(userId) {
  const { error } = await supabase
    .from('platform_admins')
    .upsert({ user_id: userId }, { onConflict: 'user_id' });
  if (error) throw error;
}

async function upsertCompanyMember(userId, companyId, role) {
  const { error } = await supabase
    .from('company_members')
    .upsert(
      { user_id: userId, company_id: companyId, role },
      { onConflict: 'user_id,company_id' },
    );
  if (error) throw error;
}

const results = [];

await assertTenantSchema();

for (const seed of users) {
  const user = await upsertAuthUser(seed);
  if (!user) throw new Error(`No se pudo crear ${seed.email}`);

  if (seed.platform) {
    await upsertPlatformAdmin(user.id);
  }

  for (const membership of seed.memberships ?? []) {
    const company = await getCompany(membership.slug);
    if (!company) {
      throw new Error(`No existe la empresa con slug "${membership.slug}". Crea/siembra esa empresa primero.`);
    }
    await upsertCompanyMember(user.id, company.id, membership.role);
    results.push({
      email: seed.email,
      password: seed.password,
      role: membership.role,
      company: `${company.name} (${company.code})`,
    });
  }

  if (seed.platform) {
    results.push({
      email: seed.email,
      password: seed.password,
      role: 'platform',
      company: 'Todas las empresas',
    });
  }
}

console.table(results);
console.log('Usuarios de prueba creados/actualizados correctamente.');

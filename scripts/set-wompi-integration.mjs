/**
 * Configura la integración Wompi de UNA empresa copiando las credenciales del
 * `.env.local` a `company_integrations`.
 *
 * Por qué existe: desde la migración multi-empresa el modo y las llaves de
 * Wompi viven POR EMPRESA en `company_integrations` (lo lee `wompiConfigFor`),
 * y el env global `WOMPI_MODE` ya no se usa en el checkout. Toda empresa nace
 * con `wompi_mode='mock'` (default de BD) y hoy no hay pantalla que lo cambie:
 * en modo mock, "Pagar" en la tienda redirige a la página simulada
 * `NEXT_PUBLIC_APP_ORIGIN/wompi/checkout/<orderId>` en vez de a Wompi.
 *
 * Uso:
 *   node scripts/set-wompi-integration.mjs                 # bros-and-subs, modo real
 *   node scripts/set-wompi-integration.mjs pizzeria-napoli
 *   node scripts/set-wompi-integration.mjs bros-and-subs --mode=mock
 */

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
  console.error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local');
  process.exit(1);
}

const args = process.argv.slice(2);
const slug = args.find(a => !a.startsWith('--')) ?? 'bros-and-subs';
const mode = args.find(a => a.startsWith('--mode='))?.split('=')[1] ?? 'real';

if (mode !== 'real' && mode !== 'mock') {
  console.error(`--mode debe ser 'real' o 'mock' (recibido: ${mode})`);
  process.exit(1);
}

const creds = {
  wompi_public_key: process.env.WOMPI_PUBLIC_KEY ?? null,
  wompi_integrity_secret: process.env.WOMPI_INTEGRITY_SECRET ?? null,
  wompi_events_secret: process.env.WOMPI_EVENTS_SECRET ?? null,
};

// En modo real el endpoint de pago responde 500 si falta la public key, y el
// webhook no puede validar firmas sin el events secret: exigimos las tres.
if (mode === 'real') {
  const missing = Object.entries(creds).filter(([, v]) => !v).map(([k]) => k.replace('wompi_', 'WOMPI_').toUpperCase());
  if (missing.length > 0) {
    console.error(`Faltan en .env.local para modo real: ${missing.join(', ')}`);
    process.exit(1);
  }
}

const mask = v => (v ? `${v.slice(0, 10)}…(${v.length})` : 'null');

const sb = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: company, error: companyErr } = await sb
  .from('companies')
  .select('id, slug, name')
  .eq('slug', slug)
  .maybeSingle();

if (companyErr) {
  console.error('Error consultando companies:', companyErr.message);
  process.exit(1);
}
if (!company) {
  const { data: all } = await sb.from('companies').select('slug').order('slug');
  console.error(`No existe la empresa '${slug}'. Disponibles: ${(all ?? []).map(c => c.slug).join(', ') || '(ninguna)'}`);
  process.exit(1);
}

const { data: before } = await sb
  .from('company_integrations')
  .select('*')
  .eq('company_id', company.id)
  .maybeSingle();

console.log(`\nEmpresa: ${company.name} (${company.slug})`);
console.log(`Antes:   wompi_mode=${before?.wompi_mode ?? '(sin fila)'} public=${mask(before?.wompi_public_key)} integrity=${mask(before?.wompi_integrity_secret)} events=${mask(before?.wompi_events_secret)}`);

const payload = { wompi_mode: mode, ...creds };

const { data: after, error: writeErr } = before
  ? await sb.from('company_integrations').update(payload).eq('company_id', company.id).select().single()
  : await sb.from('company_integrations').insert({ company_id: company.id, ...payload }).select().single();

if (writeErr) {
  console.error('Error escribiendo company_integrations:', writeErr.message);
  process.exit(1);
}

console.log(`Después: wompi_mode=${after.wompi_mode} public=${mask(after.wompi_public_key)} integrity=${mask(after.wompi_integrity_secret)} events=${mask(after.wompi_events_secret)}`);

if (mode === 'real') {
  const storefront = process.env.STOREFRONT_ORIGIN ?? '(sin definir)';
  console.log(`\nEl retorno tras pagar apunta a: ${storefront}/pedir/pago/resultado`);
  console.log('Si ese origen no es el de tu tienda actual, ajusta STOREFRONT_ORIGIN en .env.local y reinicia el backend.');
  console.log('El wompi_events_secret debe ser el mismo que tengas en el panel de Wompi para el endpoint de eventos.\n');
}

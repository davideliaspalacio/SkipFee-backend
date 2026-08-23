/**
 * Diagnóstico rápido: ¿qué esquema tiene realmente el proyecto Supabase al que
 * apunta este `.env.local`?
 *
 * Útil cuando un script o un endpoint falla con "Could not find the table
 * 'public.X' in the schema cache": eso significa que esa tabla no existe en ESE
 * proyecto (migración sin aplicar) o que apuntas al proyecto equivocado.
 *
 * Uso:  node scripts/check-db.mjs
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

const sb = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Tablas del núcleo single-tenant vs. las que añadió la fase multi-empresa.
const CORE = ['orders', 'order_items', 'customers', 'products', 'zones', 'chats', 'messages', 'settings'];
const TENANT = ['companies', 'company_members', 'company_integrations', 'platform_admins'];
const EXTRA = ['rewards', 'order_surveys', 'order_payments', 'channel_events', 'leads'];

console.log(`\nProyecto: ${new URL(url).hostname.split('.')[0]}\n`);

async function probe(label, tables) {
  console.log(label);
  for (const t of tables) {
    // Sin `head: true`: en una petición HEAD PostgREST no puede devolver el
    // cuerpo del error, y una tabla inexistente se veía como "✔ null filas".
    const { count, error } = await sb.from(t).select('*', { count: 'exact' }).limit(0);
    if (error) {
      const missing = /schema cache|does not exist/i.test(error.message);
      console.log(`  ${missing ? '✘' : '⚠'} ${t.padEnd(22)} ${missing ? 'NO EXISTE' : error.message}`);
    } else {
      console.log(`  ✔ ${t.padEnd(22)} ${count} filas`);
    }
  }
  console.log('');
}

await probe('Núcleo:', CORE);
await probe('Multi-empresa:', TENANT);
await probe('Otras:', EXTRA);

// ¿orders tiene company_id? (lo añade la migración 0038)
const { error: colErr } = await sb.from('orders').select('company_id').limit(1);
console.log(
  colErr
    ? `orders.company_id → NO existe (${colErr.message})`
    : 'orders.company_id → existe',
);
console.log('');

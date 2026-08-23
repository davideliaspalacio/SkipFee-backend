#!/usr/bin/env node
/**
 * Asegura las credenciales de `company_integrations`.
 *
 * Hace dos cosas, ambas idempotentes:
 *
 *   1. **Cifra** las columnas secretas que todavía están en texto plano
 *      (AES-256-GCM con `CREDENTIALS_KEY`). Las que ya llevan el prefijo
 *      `enc:v1:` se dejan como están.
 *
 *   2. **Siembra Wompi** en las empresas que no tienen llaves, tomándolas del
 *      `.env.local` del backend. Con llaves `pub_test_` eso deja al negocio en
 *      el sandbox de Wompi: el widget real, sin mover dinero.
 *
 * Uso:
 *   node scripts/secure-credentials.mjs                  # cifra y siembra
 *   node scripts/secure-credentials.mjs --solo-cifrar    # no toca Wompi
 *   node scripts/secure-credentials.mjs --dry-run        # dice qué haría
 *   node scripts/secure-credentials.mjs --excepto 1001   # salta esas empresas
 *   node scripts/secure-credentials.mjs --descifrar      # vuelve a texto plano
 *
 * ⚠️ La BD es la misma para el backend local y el de producción. Cifrar las
 *    credenciales de una empresa **en vivo** antes de que producción tenga la
 *    misma `CREDENTIALS_KEY` deja su bot mudo: el backend leería un criptograma
 *    donde espera una API key. Por eso existe `--excepto`: cifra primero lo que
 *    no factura, pon la clave en producción, y termina después.
 *
 * ⚠️ Si se pierde `CREDENTIALS_KEY` se pierden las credenciales cifradas. No hay
 *    recuperación: cada negocio tendría que volver a cargarlas.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// --- .env.local a mano (el script corre fuera de Next) --------------------
const env = { ...process.env };
try {
  for (const linea of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (env[m[1]] === undefined || env[m[1]] === '') env[m[1]] = v;
  }
} catch {
  // Sin .env.local seguimos con lo que haya en el entorno.
}

const soloCifrar = process.argv.includes('--solo-cifrar');
// Marcha atrás. Existe para un caso concreto: se cifró una empresa viva antes
// de que producción tuviera la clave y su bot quedó mudo. Descifrar la
// desbloquea en un comando mientras se arregla el entorno.
const descifrarTodo = process.argv.includes('--descifrar');
const dryRun = process.argv.includes('--dry-run');
const iExcepto = process.argv.indexOf('--excepto');
const excepto = new Set(
  iExcepto >= 0 ? (process.argv[iExcepto + 1] ?? '').split(',').map(c => c.trim()).filter(Boolean) : [],
);

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRole) {
  console.error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const PREFIJO = 'enc:v1:';
const SECRETAS = [
  'kapso_api_key',
  'kapso_webhook_secret',
  'evolution_api_key',
  'evolution_webhook_token',
  'wompi_integrity_secret',
  'wompi_events_secret',
];

const claveRaw = env.CREDENTIALS_KEY;
if (!claveRaw) {
  console.error(
    'Falta CREDENTIALS_KEY.\n\n' +
      'Genera una y ponla en backend-skipfee/.env.local (y en producción):\n\n' +
      `  CREDENTIALS_KEY="${randomBytes(32).toString('base64')}"\n\n` +
      'Guárdala donde guardes los demás secretos: sin ella no se pueden leer\n' +
      'las credenciales cifradas.',
  );
  process.exit(1);
}
const clave = Buffer.from(claveRaw, 'base64');
if (clave.length !== 32) {
  console.error(`CREDENTIALS_KEY debe ser de 32 bytes en base64 (son ${clave.length}).`);
  process.exit(1);
}

function descifrar(value) {
  if (!value || !value.startsWith(PREFIJO)) return value;
  const [iv, tag, datos] = value.slice(PREFIJO.length).split(':');
  const dec = createDecipheriv('aes-256-gcm', clave, Buffer.from(iv, 'base64url'));
  dec.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([dec.update(Buffer.from(datos, 'base64url')), dec.final()]).toString('utf8');
}

function cifrar(value) {
  if (!value || value.startsWith(PREFIJO)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', clave, iv);
  const datos = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIJO}${iv.toString('base64url')}:${tag.toString('base64url')}:${datos.toString('base64url')}`;
}

const sb = createClient(url, serviceRole, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: filas, error } = await sb
  .from('company_integrations')
  .select(`company_id, wompi_mode, wompi_public_key, ${SECRETAS.join(', ')}, companies(name, code)`);

if (error) {
  console.error('No se pudieron leer las integraciones:', error.message);
  process.exit(1);
}

const wompi = {
  publicKey: env.WOMPI_PUBLIC_KEY,
  integrity: env.WOMPI_INTEGRITY_SECRET,
  events: env.WOMPI_EVENTS_SECRET,
};
const hayWompi = !!(wompi.publicKey && wompi.integrity && wompi.events);
const entorno = wompi.publicKey?.startsWith('pub_test_') ? 'pruebas' : 'producción';

if (!soloCifrar && !hayWompi) {
  console.warn('⚠️  No hay WOMPI_* en el entorno: solo se cifrará lo existente.\n');
}

let cifradas = 0;
let sembradas = 0;

for (const fila of filas ?? []) {
  const empresa = fila.companies ?? {};
  const etiqueta = `${empresa.name ?? fila.company_id} (${empresa.code ?? '—'})`;
  if (excepto.has(String(empresa.code))) {
    console.log(`– ${etiqueta}: saltada (--excepto)`);
    continue;
  }
  const patch = {};

  for (const col of SECRETAS) {
    const v = fila[col];
    if (typeof v !== 'string' || !v) continue;
    if (descifrarTodo) {
      if (v.startsWith(PREFIJO)) patch[col] = descifrar(v);
    } else if (!v.startsWith(PREFIJO)) {
      patch[col] = cifrar(v);
    }
  }
  const seCifra = Object.keys(patch).length;

  let siembra = false;
  if (!soloCifrar && !descifrarTodo && hayWompi && !fila.wompi_public_key) {
    patch.wompi_public_key = wompi.publicKey;
    patch.wompi_integrity_secret = cifrar(wompi.integrity);
    patch.wompi_events_secret = cifrar(wompi.events);
    // Con llaves de prueba, `real` significa "el widget de verdad contra el
    // sandbox". Es lo que permite recorrer el pago completo sin mover dinero.
    patch.wompi_mode = 'real';
    siembra = true;
  }

  if (Object.keys(patch).length === 0) continue;

  const detalle = [
    seCifra ? `${seCifra} secreto(s) ${descifrarTodo ? 'descifrado(s)' : 'cifrado(s)'}` : null,
    siembra ? `Wompi ${entorno}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  if (dryRun) {
    console.log(`· ${etiqueta}: ${detalle}`);
  } else {
    const { error: updErr } = await sb
      .from('company_integrations')
      .update(patch)
      .eq('company_id', fila.company_id);
    if (updErr) {
      console.error(`✗ ${etiqueta}: ${updErr.message}`);
      continue;
    }
    console.log(`✓ ${etiqueta}: ${detalle}`);
  }

  if (seCifra) cifradas += seCifra;
  if (siembra) sembradas += 1;
}

console.log(
  `\n${dryRun ? '[dry-run] ' : ''}${cifradas} secreto(s) ` +
    `${descifrarTodo ? 'descifrado(s)' : 'cifrado(s)'} · ` +
    `${sembradas} empresa(s) con Wompi ${entorno}.`,
);
if (!dryRun && cifradas + sembradas > 0) {
  console.log('Reinicia el backend para que se limpie la caché de integraciones.');
}

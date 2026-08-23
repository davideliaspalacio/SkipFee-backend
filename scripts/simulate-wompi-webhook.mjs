/**
 * Simula un evento `transaction.updated` de Wompi contra nuestro webhook.
 *
 * Sirve para separar dos causas que se ven igual desde afuera ("pagué y no pasó
 * nada"): que Wompi no esté llamando a nuestra URL, o que sí llame y nosotros
 * rechacemos el evento. Firma con el MISMO algoritmo que Wompi
 * (sha256 de las propiedades + timestamp + events secret), así que si el
 * endpoint responde `applied: true`, el problema está del lado de la
 * configuración en el panel de Wompi.
 *
 * OJO: si el pedido es real y está pagable, esto lo marca como PAGADO y le
 * manda el WhatsApp de confirmación al cliente. Úsalo con un pedido de prueba.
 *
 * Uso:
 *   node scripts/simulate-wompi-webhook.mjs <orderId> <totalEnPesos> [slug]
 *   node scripts/simulate-wompi-webhook.mjs <orderId> <totalEnPesos> bros-and-subs --url=http://localhost:3000
 *   node scripts/simulate-wompi-webhook.mjs <orderId> <totalEnPesos> bros-and-subs --status=DECLINED
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { config } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env.local') });
config({ path: path.join(__dirname, '..', '.env') });

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const [orderId, totalRaw, slug = 'bros-and-subs'] = positional;
const baseUrl = (flag('url') ?? 'https://backend.skipfee.co').replace(/\/+$/, '');
const status = flag('status') ?? 'APPROVED';
const secret = flag('secret') ?? process.env.WOMPI_EVENTS_SECRET;

if (!orderId || !totalRaw) {
  console.error('Uso: node scripts/simulate-wompi-webhook.mjs <orderId> <totalEnPesos> [slug] [--url=…] [--status=…]');
  process.exit(1);
}
if (!secret) {
  console.error('Falta WOMPI_EVENTS_SECRET en .env.local (o pásalo con --secret=…)');
  process.exit(1);
}

const total = Number(totalRaw);
if (!Number.isFinite(total) || total <= 0) {
  console.error(`Total inválido: ${totalRaw} (va en PESOS, no en centavos)`);
  process.exit(1);
}

// El backend revalida que el monto coincida con orders.total * 100.
const amountInCents = Math.round(total) * 100;
const txId = `sim-${Date.now()}`;
const timestamp = Math.floor(Date.now() / 1000);

// Las tres propiedades que firma Wompi, en este orden.
const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];
const checksum = createHash('sha256')
  .update(`${txId}${status}${amountInCents}${timestamp}${secret}`)
  .digest('hex');

const event = {
  event: 'transaction.updated',
  data: {
    transaction: {
      id: txId,
      amount_in_cents: amountInCents,
      reference: orderId,
      currency: 'COP',
      payment_method_type: 'CARD',
      status,
      status_message: status === 'APPROVED' ? null : `Simulado: ${status}`,
    },
  },
  timestamp,
  signature: { properties, checksum },
};

const url = `${baseUrl}/api/webhooks/wompi/${slug}`;
console.log(`\nPOST ${url}`);
console.log(`  pedido ${orderId} · ${status} · ${amountInCents} centavos (${total} COP)\n`);

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-event-checksum': checksum },
  body: JSON.stringify(event),
});

const text = await res.text();
console.log(`HTTP ${res.status}`);
console.log(text);

if (res.status === 404) {
  console.log('\n→ 404: la empresa no existe con ese slug, o la URL no es la correcta.');
} else if (res.status === 401) {
  console.log('\n→ 401: el events secret del .env.local no coincide con el de company_integrations.');
} else if (text.includes('"applied":false')) {
  console.log('\n→ El webhook llegó pero no aplicó: la razón viene en el JSON de arriba.');
} else if (res.ok) {
  console.log('\n→ El endpoint funciona. Si pagando de verdad no pasa nada, el problema está');
  console.log('  en el panel de Wompi: revisa la URL de eventos y el events secret.');
}
console.log('');

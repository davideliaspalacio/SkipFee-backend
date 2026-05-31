import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { jsonWithCors, preflight } from '@/lib/checkout/cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/checkout/sessions  (interno — lo llama el bot)
 *
 * Crea la orden en estado `borrador` (solo `phone` + `expires_at`) y devuelve el
 * link de la tienda web para mandar por WhatsApp. El `orderId` (uuid) ES la orden
 * y funciona como token secreto.
 *
 * Contrato: CONTRACT_CHECKOUT.md §1.
 */
const bodySchema = z.object({
  phone: z.string().regex(/^\d{8,15}$/, 'phone E.164 sin "+"'),
  ttlMinutes: z.number().int().positive().max(1440).optional(),
});

function defaultTtlMinutes(): number {
  const raw = Number(process.env.CHECKOUT_TTL_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

export async function POST(request: NextRequest) {
  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return jsonWithCors({ ok: false, errors: err.issues }, 400);
    }
    return jsonWithCors({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const ttl = parsed.ttlMinutes ?? defaultTtlMinutes();
  const orderId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();

  // `orders.id` es text con default uuid; lo generamos en app para devolverlo
  // de una y armar el link sin un segundo round-trip.
  const { error } = await supabaseAdmin()
    .from('orders')
    .insert({
      id: orderId,
      phone: parsed.phone,
      status: 'borrador',
      expires_at: expiresAt,
    })
    .select('id, expires_at')
    .single();

  if (error) {
    console.error('[checkout sessions] insert error', error);
    return jsonWithCors({ ok: false, error: error.message }, 500);
  }

  const origin = process.env.STOREFRONT_ORIGIN ?? 'http://localhost:5173';
  const url = `${origin}/pedir?orderId=${orderId}&userId=${parsed.phone}`;

  return jsonWithCors({ ok: true, orderId, url, expiresAt });
}

export async function OPTIONS() {
  return preflight();
}

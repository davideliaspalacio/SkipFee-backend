import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { jsonWithCors, preflight } from '@/lib/checkout/cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/checkout/sessions  (interno — lo llama el bot)
 *
 * Crea la orden en estado `borrador` y devuelve el link de la tienda web. El
 * `orderId` (uuid) ES la orden y funciona como token secreto.
 *
 * El bot recolecta los datos del cliente y la dirección por WhatsApp ANTES de
 * crear la sesión, así que pueden venir en el body. Si vienen:
 *   - upsert del customer (matched por `phone`)
 *   - persistimos customer_id + address + zone_id + lat/lng en la orden ya
 *     creada (la web solo necesita elegir productos + pagar).
 *
 * Si NO vienen (compat con clientes que solo manden phone), la orden queda
 * con esos campos null y el cliente los completa en la web (modo legacy).
 */
const bodySchema = z.object({
  phone: z.string().regex(/^\d{8,15}$/, 'phone E.164 sin "+"'),
  ttlMinutes: z.number().int().positive().max(1440).optional(),
  /** Datos del cliente. Si vienen, se hace upsert por phone. */
  customer: z
    .object({
      name: z.string().min(1).max(120),
      email: z.string().email().max(200).optional().or(z.literal('')),
    })
    .optional(),
  /** Dirección + zona. Si vienen, se persiste en la orden. */
  delivery: z
    .object({
      address: z.string().min(1).max(500),
      zoneId: z.string().min(1),
      lat: z.number().optional(),
      lng: z.number().optional(),
      persist: z.boolean().optional(), // default true: guardar la dirección en el cliente
    })
    .optional(),
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
  const sb = supabaseAdmin();

  // 1. Si vino dirección + zona: resolver la zona para sacar lat/lng de fallback.
  let zone: { id: string; lat: number; lng: number } | null = null;
  if (parsed.delivery) {
    const { data: z } = (await sb
      .from('zones')
      .select('id, lat, lng')
      .eq('id', parsed.delivery.zoneId)
      .single()) as { data: { id: string; lat: number; lng: number } | null };
    if (!z) {
      return jsonWithCors(
        { ok: false, error: `Zona no existe: ${parsed.delivery.zoneId}` },
        400,
      );
    }
    zone = z;
  }

  // 2. Si vino customer: upsert (matched por phone, UNIQUE).
  //    persist=false ("Sí pero no guardar") + cliente ya existente ⇒ NO se
  //    sobreescribe su dirección guardada (la orden igual lleva la de este pedido).
  let customerId: string | null = null;
  if (parsed.customer) {
    const email =
      parsed.customer.email && parsed.customer.email !== '' ? parsed.customer.email : null;
    const persist = parsed.delivery?.persist !== false; // default true

    if (!persist) {
      const { data: existing } = await sb
        .from('customers')
        .select('id')
        .eq('phone', parsed.phone)
        .maybeSingle();
      if (existing) {
        // Preservar la dirección guardada; solo refrescamos nombre/email.
        await sb
          .from('customers')
          .update({ name: parsed.customer.name, email })
          .eq('id', (existing as { id: string }).id);
        customerId = (existing as { id: string }).id;
      }
    }

    if (!customerId) {
      // persist=true, o cliente nuevo (no hay dirección previa que preservar).
      const { data: customer, error: custErr } = await sb
        .from('customers')
        .upsert(
          {
            name: parsed.customer.name,
            phone: parsed.phone,
            addr: parsed.delivery?.address ?? '',
            zone_id: parsed.delivery?.zoneId ?? null,
            email,
            tag: 'Nuevo',
          },
          { onConflict: 'phone' },
        )
        .select('id')
        .single();
      if (custErr || !customer) {
        console.error('[checkout sessions] customer upsert error', custErr);
        return jsonWithCors({ ok: false, error: custErr?.message ?? 'customer error' }, 500);
      }
      customerId = (customer as { id: string }).id;
    }
  }

  // 3. INSERT order — borrador con todo lo que vino pre-llenado.
  const insertPayload: Record<string, unknown> = {
    id: orderId,
    phone: parsed.phone,
    status: 'borrador',
    expires_at: expiresAt,
  };
  if (customerId) insertPayload.customer_id = customerId;
  if (parsed.delivery) {
    insertPayload.address = parsed.delivery.address;
    insertPayload.zone_id = parsed.delivery.zoneId;
    // Coordenadas reales del cliente (geocode/ubicación) si vinieron; si no, el
    // centro de la zona como fallback (para que el mapa de despachos funcione).
    const lat = typeof parsed.delivery.lat === 'number' ? parsed.delivery.lat : zone?.lat;
    const lng = typeof parsed.delivery.lng === 'number' ? parsed.delivery.lng : zone?.lng;
    if (typeof lat === 'number') insertPayload.lat = lat;
    if (typeof lng === 'number') insertPayload.lng = lng;
  }

  const { error } = await sb
    .from('orders')
    .insert(insertPayload)
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

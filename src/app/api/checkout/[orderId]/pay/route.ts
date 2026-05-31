import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { jsonWithCors, preflight } from '@/lib/checkout/cors';
import { classifyOrder } from '@/lib/checkout/shape';
import { generateIntegritySignature } from '@/lib/wompi/signature';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/checkout/:orderId/pay   (público — la web al pulsar "Pagar")
 *
 * Valida que el carrito + dirección guardados estén completos, hace upsert del
 * customer por phone, y devuelve datos para iniciar el pago. NO cambia el
 * estado: la orden sigue `borrador` hasta que el webhook confirme el pago.
 *
 * Respuesta varía según WOMPI_MODE:
 *  - `mock` (default): `{ ok, total, paymentLink: <mock URL>, widgetConfig: null }`
 *    El frontend redirige a esa URL (página local que simula el pago).
 *  - `real`: `{ ok, total, paymentLink: null, widgetConfig: { publicKey, currency,
 *    amountInCents, reference, signature, redirectUrl, customerData } }`
 *    El frontend instancia el Widget oficial (checkout.wompi.co/widget.js).
 *
 * Contrato: CONTRACT_CHECKOUT.md §4.
 *  - 400 { missing: [...] }  si falta algo para pagar (items/address/zoneId/name).
 *  - 409 { status }          si la orden ya no es editable.
 *
 * El carrito y la dirección se asumen ya guardados vía PUT /cart (flujo canónico).
 */
const bodySchema = z.object({
  customer: z.object({
    name: z.string().min(1).max(120),
    email: z.string().email().max(200).optional().or(z.literal('')),
  }),
  paymentMethod: z.string().min(1).max(60).optional(),
  note: z.string().max(500).optional(),
});

export async function POST(request: NextRequest, ctx: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await ctx.params;

  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return jsonWithCors({ ok: false, errors: err.issues }, 400);
    }
    return jsonWithCors({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const sb = supabaseAdmin();

  const { data: order } = (await sb
    .from('orders')
    .select('id, phone, status, expires_at, address, zone_id, lat, lng, total, items:order_items(qty, price_at_order)')
    .eq('id', orderId)
    .single()) as {
    data:
      | {
          id: string;
          phone: string;
          status: string;
          expires_at: string | null;
          address: string | null;
          zone_id: string | null;
          lat: number | null;
          lng: number | null;
          total: number | null;
          items: Array<{ qty: number; price_at_order: number }> | null;
        }
      | null;
  };

  const status = classifyOrder(order, new Date());
  if (status !== 'valida' || !order) {
    const reported = status === 'ya_usada' ? 'ya_usada' : 'expirada';
    return jsonWithCors({ ok: false, status: reported, error: 'El carrito ya no es editable' }, 409);
  }

  // Completitud para pagar.
  const missing: string[] = [];
  if (!order.items || order.items.length === 0) missing.push('items');
  if (!order.address) missing.push('address');
  if (!order.zone_id) missing.push('zoneId');
  if (!parsed.customer.name?.trim()) missing.push('name');
  if (missing.length > 0) {
    return jsonWithCors({ ok: false, error: 'Falta información para pagar', missing }, 400);
  }

  // Upsert customer por phone (UNIQUE).
  const email = parsed.customer.email && parsed.customer.email !== '' ? parsed.customer.email : null;
  const { data: customer, error: custErr } = await sb
    .from('customers')
    .upsert(
      {
        name: parsed.customer.name,
        phone: order.phone,
        addr: order.address ?? '',
        zone_id: order.zone_id,
        email,
        tag: 'Nuevo',
      },
      { onConflict: 'phone' },
    )
    .select('id')
    .single();

  if (custErr || !customer) {
    console.error('[checkout pay] customer upsert error', custErr);
    return jsonWithCors({ ok: false, error: custErr?.message ?? 'customer error' }, 500);
  }

  // Ligar customer + payment_method + note a la orden. NO cambiamos status.
  const update: Record<string, unknown> = {
    customer_id: (customer as { id: string }).id,
    payment_method: parsed.paymentMethod ?? 'Wompi · Tarjeta',
  };
  if (parsed.note !== undefined) update.note = parsed.note;

  const { error: updErr } = await sb.from('orders').update(update).eq('id', orderId);
  if (updErr) {
    console.error('[checkout pay] order update error', updErr);
    return jsonWithCors({ ok: false, error: updErr.message }, 500);
  }

  const total = order.total ?? 0;

  // Dispatch según WOMPI_MODE: mock → paymentLink local, real → widgetConfig
  // para el Widget oficial. El frontend nuevo chequea widgetConfig primero y
  // cae a paymentLink si es null (compat).
  if ((process.env.WOMPI_MODE ?? 'mock') === 'real') {
    const publicKey = process.env.WOMPI_PUBLIC_KEY;
    if (!publicKey) {
      return jsonWithCors(
        { ok: false, error: 'WOMPI_PUBLIC_KEY no configurado (requerido con WOMPI_MODE=real)' },
        500,
      );
    }
    let signature: string;
    try {
      signature = generateIntegritySignature({
        reference: orderId,
        amountInCents: total * 100,
        currency: 'COP',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'integrity signature error';
      return jsonWithCors({ ok: false, error: msg }, 500);
    }
    const storefrontOrigin = process.env.STOREFRONT_ORIGIN ?? 'http://localhost:5173';
    const widgetConfig = {
      publicKey,
      currency: 'COP' as const,
      amountInCents: total * 100,
      reference: orderId,
      signature,
      redirectUrl: `${storefrontOrigin}/pedir/pago/resultado?orderId=${orderId}`,
      customerData: {
        email: email ?? undefined,
        fullName: parsed.customer.name,
        phoneNumber: order.phone,
        phoneNumberPrefix: '+57',
      },
    };
    return jsonWithCors({ ok: true, total, paymentLink: null, widgetConfig });
  }

  // Mock: página local que simula el pago.
  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'http://localhost:3000';
  const paymentLink = `${origin}/wompi/checkout/${orderId}`;
  return jsonWithCors({ ok: true, total, paymentLink, widgetConfig: null });
}

export async function OPTIONS() {
  return preflight();
}

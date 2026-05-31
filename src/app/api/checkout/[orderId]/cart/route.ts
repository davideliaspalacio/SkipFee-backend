import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { jsonWithCors, preflight } from '@/lib/checkout/cors';
import { classifyOrder } from '@/lib/checkout/shape';
import { computeOrderTotals, type TotalsProduct, type TotalsZone } from '@/lib/checkout/totals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PUT /api/checkout/:orderId/cart   (público — la web cada vez que el cliente edita)
 *
 * Reemplaza el carrito completo (y, si se manda, la dirección/zona). Idempotente.
 * Recalcula totales server-side con `computeOrderTotals` y persiste order_items +
 * dirección/zona/total. La orden SIGUE en `borrador` (editable hasta pagar).
 *
 * Contrato: CONTRACT_CHECKOUT.md §3.
 *  - 409 { status: expirada|ya_usada }  si la orden ya no es editable.
 *  - 409 { unavailable: [...] }          si hay productos no disponibles.
 *  - 400 { errors }                      validación zod.
 *
 * `delivery` puede venir SIN lat/lng (no hay mapa aún): se tolera y se usan las
 * coordenadas de la zona como fallback al persistir.
 */
const bodySchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        qty: z.number().int().min(1).max(99),
      }),
    )
    .max(50),
  delivery: z
    .object({
      address: z.string().min(1).max(500).optional(),
      zoneId: z.string().min(1).optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
    })
    .optional(),
});

export async function PUT(request: NextRequest, ctx: { params: Promise<{ orderId: string }> }) {
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
    .select('id, status, expires_at')
    .eq('id', orderId)
    .single()) as { data: { id: string; status: string; expires_at: string | null } | null };

  const status = classifyOrder(order, new Date());
  if (status !== 'valida' || !order) {
    // 409 para que la web redirija a "carrito vencido". no_encontrada se colapsa a
    // expirada (un link inexistente es, para el cliente, un carrito muerto).
    const reported = status === 'ya_usada' ? 'ya_usada' : 'expirada';
    return jsonWithCors(
      { ok: false, status: reported, error: 'El carrito ya no es editable' },
      409,
    );
  }

  // Catálogo + zona + settings para recalcular.
  const [{ data: products }, { data: settings }] = await Promise.all([
    sb.from('products').select('id, name, price, cat, available'),
    sb.from('settings').select('peak_start, peak_end, base_delivery_fee').eq('id', 1).single(),
  ]);

  if (!settings) {
    return jsonWithCors({ ok: false, error: 'Settings no inicializado' }, 500);
  }

  const zoneId = parsed.delivery?.zoneId ?? null;
  let zone: (TotalsZone & { color?: string }) | null = null;
  if (zoneId) {
    const { data: z } = (await sb
      .from('zones')
      .select('id, name, tarifa, recargo, color, lat, lng')
      .eq('id', zoneId)
      .single()) as { data: (TotalsZone & { color?: string }) | null };
    if (!z) {
      return jsonWithCors({ ok: false, error: `Zona no existe: ${zoneId}` }, 400);
    }
    zone = z;
  }

  const totals = computeOrderTotals({
    items: parsed.items,
    products: (products ?? []) as TotalsProduct[],
    zone,
    settings,
    now: new Date(),
  });

  if (totals.missing.length > 0) {
    return jsonWithCors(
      { ok: false, error: `Producto no existe: ${totals.missing.join(', ')}` },
      400,
    );
  }
  if (totals.unavailable.length > 0) {
    return jsonWithCors(
      { ok: false, error: 'Algunos productos no están disponibles', unavailable: totals.unavailable },
      409,
    );
  }

  // Persistir: reemplazar order_items y actualizar la orden (sigue borrador).
  const { error: delErr } = await sb.from('order_items').delete().eq('order_id', orderId);
  if (delErr) {
    console.error('[checkout cart] delete items error', delErr);
    return jsonWithCors({ ok: false, error: delErr.message }, 500);
  }

  if (totals.itemsToInsert.length > 0) {
    const rows = totals.itemsToInsert.map(i => ({ ...i, order_id: orderId }));
    const { error: insErr } = await sb.from('order_items').insert(rows);
    if (insErr) {
      console.error('[checkout cart] insert items error', insErr);
      return jsonWithCors({ ok: false, error: insErr.message }, 500);
    }
  }

  // Coordenadas: si no llegaron, usar las de la zona como fallback.
  const lat = parsed.delivery?.lat ?? zone?.lat ?? null;
  const lng = parsed.delivery?.lng ?? zone?.lng ?? null;

  const update: Record<string, unknown> = { total: totals.total };
  if (parsed.delivery) {
    if (parsed.delivery.address !== undefined) update.address = parsed.delivery.address;
    if (zoneId) update.zone_id = zoneId;
    if (lat !== null) update.lat = lat;
    if (lng !== null) update.lng = lng;
  }

  const { error: updErr } = await sb.from('orders').update(update).eq('id', orderId);
  if (updErr) {
    console.error('[checkout cart] update order error', updErr);
    return jsonWithCors({ ok: false, error: updErr.message }, 500);
  }

  const deliveryOut = parsed.delivery
    ? {
        address: parsed.delivery.address ?? null,
        zoneId: zoneId ?? null,
        lat,
        lng,
      }
    : null;

  return jsonWithCors({
    ok: true,
    cart: {
      items: totals.items,
      subtotal: totals.subtotal,
      delivery: totals.delivery,
      peakSurcharge: totals.peakSurcharge,
      total: totals.total,
    },
    delivery: deliveryOut,
  });
}

export async function OPTIONS() {
  return preflight();
}

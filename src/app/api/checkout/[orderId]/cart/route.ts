import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { jsonWithCors, preflight } from '@/lib/checkout/cors';
import { classifyOrder, type Cart } from '@/lib/checkout/shape';
import { giftCartLine } from '@/lib/checkout/gift';
import { computeOrderTotals, type TotalsProduct, type TotalsZone } from '@/lib/checkout/totals';
import type { PromotionRow } from '@/lib/checkout/promotions';

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
  // Propina (solo tienda web): tipPercent (p. ej. 10) se calcula sobre el subtotal;
  // si no, tip es un monto custom. Default: sin propina.
  tipPercent: z.number().int().min(0).max(100).optional(),
  tip: z.number().int().min(0).max(1_000_000).optional(),
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
    .select('id, status, expires_at, zone_id, phone')
    .eq('id', orderId)
    .single()) as {
    data: { id: string; status: string; expires_at: string | null; zone_id: string | null; phone: string } | null;
  };

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

  // Catálogo + zona + settings + promos activas (todos en paralelo).
  // Las promos las filtra `computeOrderTotals` por aplicabilidad real.
  const [{ data: products }, { data: settings }, { data: promotions }] = await Promise.all([
    sb.from('products').select('id, name, price, cat, available'),
    sb.from('settings').select('peak_start, peak_end, base_delivery_fee, review_gift_product_id').eq('id', 1).single(),
    sb.from('promotions')
      .select('id, kind, name, description, discount_type, discount_value, min_subtotal, config, active, starts_at, ends_at')
      .eq('active', true)
      .eq('archived', false),
  ]);

  if (!settings) {
    return jsonWithCors({ ok: false, error: 'Settings no inicializado' }, 500);
  }

  // La entrega la captura el bot y es read-only en la tienda: cuando el cliente
  // solo edita items, el body NO trae zoneId. Caemos a la zona guardada en la
  // orden para que el domicilio (zone.tarifa) SIEMPRE se cobre y nunca quede en 0.
  const zoneId = parsed.delivery?.zoneId ?? order.zone_id;
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

  // El postre de regalo (si está vinculado) NO es un item editable: se inyecta
  // aparte como línea $0 y suele estar "no disponible" (oculto del menú). Si el
  // cliente lo reenvía en el body, lo ignoramos para no marcarlo "no disponible"
  // ni persistirlo — el order_item real lo agrega el canje al pagar.
  const giftProductId =
    (settings as { review_gift_product_id?: string | null }).review_gift_product_id ?? null;
  const clientItems = giftProductId
    ? parsed.items.filter(i => i.productId !== giftProductId)
    : parsed.items;

  const totals = computeOrderTotals({
    items: clientItems,
    products: (products ?? []) as TotalsProduct[],
    zone,
    settings,
    now: new Date(),
    promotions: (promotions ?? []) as PromotionRow[],
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

  // Propina (Tarea: 10% / custom, solo tienda web): el 10% se calcula sobre el
  // subtotal (la comida); si no, se usa el monto custom. Se suma al total.
  const tipPercent = parsed.tipPercent && parsed.tipPercent > 0 ? parsed.tipPercent : null;
  const tip = tipPercent ? Math.round((totals.subtotal * tipPercent) / 100) : (parsed.tip ?? 0);
  const totalConPropina = totals.total + tip;

  // `total` ya incluye el descuento (computeOrderTotals lo restó) y la propina.
  // Persistimos discount/promo_id/tip/tip_percent para que el GET devuelva el
  // mismo desglose y para auditoría/reportes.
  const update: Record<string, unknown> = {
    total: totalConPropina,
    discount: totals.discount,
    promo_id: totals.appliedPromo?.id ?? null,
    tip,
    tip_percent: tipPercent,
  };
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

  // Postre de regalo (Tarea 3): se muestra como línea $0 en el carrito (igual que
  // en el GET). No se persiste en order_items hasta pagar (redeemRewardForOrder).
  const giftLine = await giftCartLine(sb, order.phone);
  const items: Cart['items'] = [...totals.items];
  if (giftLine) items.push(giftLine);

  return jsonWithCors({
    ok: true,
    cart: {
      items,
      subtotal: totals.subtotal,
      discount: totals.discount,
      delivery: totals.delivery,
      peakSurcharge: totals.peakSurcharge,
      tip,
      tipPercent,
      total: totalConPropina,
      appliedPromo: totals.appliedPromo,
    },
    delivery: deliveryOut,
  });
}

export async function OPTIONS() {
  return preflight();
}

import { z } from 'zod';
import { serializeOrder } from '@/lib/serializers';
import { redeemRewardForOrder } from '@/lib/orders/rewards';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ORDER_SELECT = `
  id, order_number, total, tip, tip_percent, status, address, phone, payment_method, note, lat, lng, created_at,
  sales_channel, external_order_id, external_store_id, channel_status, channel_delivery_method, channel_commission, channel_discount,
  customer:customers(id, name),
  zone:zones(id, name),
  cook:cooks(id, name),
  items:order_items(qty, product:products(name))
`;

const DEFAULT_DELIVERED_WINDOW_HOURS = 8;

/**
 * GET /api/<companyId>/orders?status=...&zoneId=...&limit=...
 * Pedidos de LA empresa, serializados con la forma del frontend (kanban admin).
 *
 * Aislamiento: `ctx.db` es el cliente con el JWT del usuario (RLS = capa 2) y
 * además filtramos explícitamente por `company_id` (capa 1).
 */
export const GET = withTenant(async (request, ctx) => {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const zoneId = url.searchParams.get('zoneId');
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 200, 500) : 200;

  // Ventana rodante para "entregado" — settings ahora es por empresa.
  const { data: settingsRow } = await ctx.db
    .from('settings')
    .select('delivered_window_hours')
    .eq('company_id', ctx.company.id)
    .maybeSingle();
  const windowHours: number =
    typeof settingsRow?.delivered_window_hours === 'number'
      ? settingsRow.delivered_window_hours
      : DEFAULT_DELIVERED_WINDOW_HOURS;
  const cutoffIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  let query = ctx.db
    .from('orders')
    .select(ORDER_SELECT)
    .eq('company_id', ctx.company.id)
    .neq('status', 'expirado')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (zoneId) query = query.eq('zone_id', zoneId);

  if (status === 'entregado') {
    query = query.eq('status', status).gte('created_at', cutoffIso);
  } else if (status) {
    query = query.eq('status', status);
  } else {
    query = query.or(`status.neq.entregado,created_at.gte.${cutoffIso}`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[orders GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const orders = (data ?? [])
    .filter(row => row.status !== 'borrador' || row.total > 0)
    .map(serializeOrder);
  return Response.json({ ok: true, orders });
});

const bodySchema = z.object({
  customer: z.object({
    name: z.string().min(1).max(120),
    phone: z.string().regex(/^\d{8,15}$/, 'phone E.164 sin "+"'),
    addr: z.string().min(1).max(500),
  }),
  zoneId: z.string(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        qty: z.number().int().positive().max(99),
      }),
    )
    .min(1)
    .max(50),
  paymentMethod: z.string().min(1).max(60),
  note: z.string().max(500).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

/**
 * POST /api/<companyId>/orders — crea un pedido (estado=nuevo) para LA empresa.
 * order_number lo asigna el trigger por empresa (#1, #2, ... independiente).
 */
export const POST = withTenant(async (request, ctx) => {
  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const sb = ctx.db;
  const companyId = ctx.company.id;

  // 0. Rate limit por teléfono dentro de la empresa: máximo 10 pedidos/hora.
  const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const RATE_LIMIT_PER_HOUR = 10;
  const { count: recentCount, error: rlErr } = await sb
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('phone', parsed.customer.phone)
    .gte('created_at', ONE_HOUR_AGO);
  if (rlErr) {
    console.error('[orders POST] rate limit check failed', rlErr);
  } else if ((recentCount ?? 0) >= RATE_LIMIT_PER_HOUR) {
    return Response.json(
      {
        ok: false,
        error: `Llegaste al máximo de ${RATE_LIMIT_PER_HOUR} pedidos por hora. Intentá de nuevo más tarde.`,
        retryAfterSeconds: 3600,
      },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }

  // 1. Resolver productos (solo de la empresa).
  const productIds = parsed.items.map(i => i.productId);
  const { data: products, error: prodErr } = await sb
    .from('products')
    .select('id, name, price, available')
    .eq('company_id', companyId)
    .in('id', productIds);

  if (prodErr) {
    return Response.json({ ok: false, error: prodErr.message }, { status: 500 });
  }

  const productById = new Map((products ?? []).map(p => [p.id, p]));
  const unavailable: string[] = [];
  let subtotal = 0;
  const itemsToInsert: Array<{ product_id: string; qty: number; price_at_order: number }> = [];

  for (const it of parsed.items) {
    const p = productById.get(it.productId);
    if (!p) {
      return Response.json(
        { ok: false, error: `Producto no existe: ${it.productId}` },
        { status: 400 },
      );
    }
    if (!p.available) {
      unavailable.push(p.name);
      continue;
    }
    subtotal += p.price * it.qty;
    itemsToInsert.push({ product_id: p.id, qty: it.qty, price_at_order: p.price });
  }

  if (unavailable.length > 0) {
    return Response.json(
      { ok: false, error: 'Algunos productos no están disponibles', unavailable },
      { status: 409 },
    );
  }

  // 2. Verificar zona (de la empresa) y delivery.
  const { data: zone, error: zErr } = await sb
    .from('zones')
    .select('id, name, tarifa, lat, lng')
    .eq('company_id', companyId)
    .eq('id', parsed.zoneId)
    .single();

  if (zErr || !zone) {
    return Response.json(
      { ok: false, error: `Zona no existe: ${parsed.zoneId}` },
      { status: 400 },
    );
  }

  const delivery = zone.tarifa;
  const total = subtotal + delivery;

  // 3. Upsert customer por (company_id, phone) — único por empresa.
  const { data: customer, error: custErr } = await sb
    .from('customers')
    .upsert(
      {
        company_id: companyId,
        name: parsed.customer.name,
        phone: parsed.customer.phone,
        addr: parsed.customer.addr,
        zone_id: parsed.zoneId,
        tag: 'Nuevo',
      },
      { onConflict: 'company_id,phone' },
    )
    .select('id')
    .single();

  if (custErr || !customer) {
    console.error('[orders] customer upsert error', custErr);
    return Response.json({ ok: false, error: custErr?.message ?? 'customer error' }, {
      status: 500,
    });
  }

  // 4. Insertar order (order_number lo pone el trigger por empresa).
  const { data: order, error: ordErr } = await sb
    .from('orders')
    .insert({
      company_id: companyId,
      customer_id: customer.id,
      total,
      zone_id: parsed.zoneId,
      status: 'nuevo',
      address: parsed.customer.addr,
      phone: parsed.customer.phone,
      payment_method: parsed.paymentMethod,
      note: parsed.note ?? null,
      lat: parsed.lat ?? zone.lat,
      lng: parsed.lng ?? zone.lng,
      sales_channel: 'manual',
    })
    .select('id, order_number')
    .single();

  if (ordErr || !order) {
    console.error('[orders] order insert error', ordErr);
    return Response.json({ ok: false, error: ordErr?.message ?? 'order error' }, { status: 500 });
  }

  // 5. Insertar order_items (con company_id denormalizado para RLS/joins).
  const itemsWithOrderId = itemsToInsert.map(i => ({
    ...i,
    order_id: order.id,
    company_id: companyId,
  }));
  const { error: itemsErr } = await sb.from('order_items').insert(itemsWithOrderId);

  if (itemsErr) {
    console.error('[orders] order_items insert error', itemsErr);
    return Response.json({ ok: false, error: itemsErr.message }, { status: 500 });
  }

  // 5b. Post-venta: canje de cupón de postre. TODO(multi-empresa): redeemRewardForOrder
  //     debe scopearse por company_id internamente (rewards/products por empresa).
  await redeemRewardForOrder({ sb, orderId: order.id, phone: parsed.customer.phone, companyId });

  // 6. Mock payment link (se reemplaza por Wompi real por empresa).
  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'http://localhost:3000';
  const paymentLink = `${origin}/wompi/checkout/${order.id}`;

  return Response.json({
    ok: true,
    orderId: order.id,
    orderNumber: order.order_number,
    subtotal,
    delivery,
    peakSurcharge: 0,
    total,
    paymentLink,
  });
});

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { serializeOrder } from '@/lib/serializers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ORDER_SELECT = `
  id, order_number, total, status, address, phone, payment_method, note, lat, lng, created_at,
  customer:customers(id, name),
  zone:zones(id, name),
  items:order_items(qty, product:products(name))
`;

/**
 * GET /api/orders?status=...&zoneId=...&limit=...
 * Devuelve pedidos serializados con la forma del frontend (cliente nombre,
 * zone string, items texto, etc.). Lo consume el panel admin (kanban).
 */
const DEFAULT_DELIVERED_WINDOW_HOURS = 8;

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const zoneId = url.searchParams.get('zoneId');
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 200, 500) : 200;

  const sb = supabaseAdmin();

  // Ventana rodante para "entregado": evita que el límite global se llene de
  // entregados viejos (los empujarían afuera). Configurable desde settings,
  // con fallback a 8 h por si la lectura falla.
  const { data: settingsRow } = await sb
    .from('settings')
    .select('delivered_window_hours')
    .eq('id', 1)
    .single();
  const windowHours: number =
    typeof settingsRow?.delivered_window_hours === 'number'
      ? settingsRow.delivered_window_hours
      : DEFAULT_DELIVERED_WINDOW_HOURS;
  const cutoffIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  // El kanban admin muestra los pedidos reales + los carritos del checkout web
  // que YA tienen carrito armado: aparecen en la columna "Nuevo" marcados como
  // "Sin pagar". Excluimos los `expirado`; los borradores vacíos (todavía sin
  // items) se filtran abajo, tras la query.
  let query = sb
    .from('orders')
    .select(ORDER_SELECT)
    .neq('status', 'expirado')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (zoneId) query = query.eq('zone_id', zoneId);

  if (status === 'entregado') {
    query = query.eq('status', status).gte('created_at', cutoffIso);
  } else if (status) {
    query = query.eq('status', status);
  } else {
    // Sin filtro: la cláusula or() dice "NO es entregado, O bien es entregado
    // pero cae dentro de la ventana". Las otras columnas no se ven afectadas.
    query = query.or(`status.neq.entregado,created_at.gte.${cutoffIso}`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[orders GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Ocultamos los borradores SIN carrito (total NULL/0): son sesiones de checkout
  // recién creadas que el cliente aún no llenó. Los borradores con carrito
  // (total > 0) sí se muestran como "Sin pagar" en la columna "Nuevo".
  const orders = (data ?? [])
    .filter(row => row.status !== 'borrador' || row.total > 0)
    .map(serializeOrder);
  return Response.json({ ok: true, orders });
}

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
 * Crea un pedido en estado=nuevo.
 *
 * Pasos:
 * 1. Resuelve productos (verifica disponibilidad y obtiene precios).
 * 2. Upsert del customer por phone (único).
 * 3. Calcula el total con la misma lógica de /api/quotes (zona + recargo hora pico).
 * 4. Inserta order + order_items.
 * 5. Devuelve order.id + paymentLink (mock por ahora).
 *
 * Cuando llegue Wompi real (Task #24), el paymentLink lo genera /api/wompi/checkout.
 */
export async function POST(request: NextRequest) {
  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const sb = supabaseAdmin();

  // 0. Rate limit por teléfono: máximo 10 pedidos por hora.
  //    Esto evita abuso del bot (un cliente disparado o malicioso).
  //    Si querés afinarlo (ej. exceptuar VIPs, ventanas distintas, IP),
  //    aquí es el lugar.
  const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const RATE_LIMIT_PER_HOUR = 10;
  const { count: recentCount, error: rlErr } = await sb
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('phone', parsed.customer.phone)
    .gte('created_at', ONE_HOUR_AGO);
  if (rlErr) {
    console.error('[orders POST] rate limit check failed', rlErr);
    // No queremos bloquear si la query de rate-limit falla — fallback a permitir.
  } else if ((recentCount ?? 0) >= RATE_LIMIT_PER_HOUR) {
    return Response.json(
      {
        ok: false,
        error: `Llegaste al máximo de ${RATE_LIMIT_PER_HOUR} pedidos por hora. Intentá de nuevo más tarde.`,
        retryAfterSeconds: 3600,
      },
      {
        status: 429,
        headers: { 'Retry-After': '3600' },
      },
    );
  }

  // 1. Resolver productos
  const productIds = parsed.items.map(i => i.productId);
  const { data: products, error: prodErr } = await sb
    .from('products')
    .select('id, name, price, available')
    .in('id', productIds);

  if (prodErr) {
    return Response.json({ ok: false, error: prodErr.message }, { status: 500 });
  }

  const productById = new Map((products ?? []).map(p => [p.id, p]));
  const unavailable: string[] = [];
  let subtotal = 0;
  const itemsToInsert: Array<{
    product_id: string;
    qty: number;
    price_at_order: number;
  }> = [];

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
    itemsToInsert.push({
      product_id: p.id,
      qty: it.qty,
      price_at_order: p.price,
    });
  }

  if (unavailable.length > 0) {
    return Response.json(
      { ok: false, error: 'Algunos productos no están disponibles', unavailable },
      { status: 409 },
    );
  }

  // 2. Verificar zona y calcular delivery (hora pico eliminada: delivery = zone.tarifa)
  const { data: zone, error: zErr } = await sb
    .from('zones')
    .select('id, name, tarifa, lat, lng')
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

  // 3. Upsert customer por phone (phone es UNIQUE)
  const { data: customer, error: custErr } = await sb
    .from('customers')
    .upsert(
      {
        name: parsed.customer.name,
        phone: parsed.customer.phone,
        addr: parsed.customer.addr,
        zone_id: parsed.zoneId,
        tag: 'Nuevo',
      },
      { onConflict: 'phone' },
    )
    .select('id')
    .single();

  if (custErr || !customer) {
    console.error('[orders] customer upsert error', custErr);
    return Response.json({ ok: false, error: custErr?.message ?? 'customer error' }, {
      status: 500,
    });
  }

  // 4. Insertar order
  const { data: order, error: ordErr } = await sb
    .from('orders')
    .insert({
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
    })
    .select('id, order_number')
    .single();

  if (ordErr || !order) {
    console.error('[orders] order insert error', ordErr);
    return Response.json({ ok: false, error: ordErr?.message ?? 'order error' }, { status: 500 });
  }

  // 5. Insertar order_items
  const itemsWithOrderId = itemsToInsert.map(i => ({ ...i, order_id: order.id }));
  const { error: itemsErr } = await sb.from('order_items').insert(itemsWithOrderId);

  if (itemsErr) {
    console.error('[orders] order_items insert error', itemsErr);
    return Response.json({ ok: false, error: itemsErr.message }, { status: 500 });
  }

  // 6. Mock payment link (se reemplaza por checkout.wompi.co real cuando llegue cuenta)
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
}

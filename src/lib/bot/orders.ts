import { supabaseAdmin } from '@/lib/db';
import { redeemRewardForOrder } from '@/lib/orders/rewards';

/**
 * Creación de pedidos DESDE EL BOT, directo en BD (multi-empresa).
 *
 * Antes el bot hacía `POST /api/orders` (self-fetch). Esa ruta global ya no
 * existe: las rutas de negocio viven en `/api/<slug>/orders` y exigen sesión de
 * usuario (`withTenant`), algo que el bot NO tiene. Por eso el bot crea el
 * pedido directamente con `supabaseAdmin()` (service_role), insertando
 * `company_id` en customer/order/order_items, replicando la lógica del handler
 * POST de `app/api/[companyId]/orders/route.ts` pero scopeada por empresa.
 *
 * Decisión (documentada en el resumen): se REPLICA la lógica en vez de
 * extraerla a un helper compartido con la ruta. La ruta usa `ctx.db` (cliente
 * con el JWT del usuario, RLS de por medio) y devuelve `Response`; el bot usa
 * service_role y necesita un valor plano. Acoplarlos exigiría parametrizar
 * cliente + forma de retorno y arrastrar la ruta (otro agente) a este cambio.
 * El cálculo es simple (productos + zona + total) y vive en un único lugar por
 * dominio. Si la lógica crece, conviene extraer un `createOrderCore({ db, … })`.
 */

export interface BotOrderItem {
  productId: string;
  qty: number;
}

export interface CreateBotOrderInput {
  companyId: string;
  customerName: string;
  phone: string;
  address: string;
  zoneId: string;
  items: BotOrderItem[];
  paymentMethod: string;
  note?: string;
  lat?: number;
  lng?: number;
}

export type CreateBotOrderResult =
  | {
      ok: true;
      orderId: string;
      orderNumber: number | null;
      subtotal: number;
      delivery: number;
      total: number;
      paymentLink: string;
    }
  | { ok: false; error: string; unavailable?: string[] };

/**
 * Crea un pedido (estado `nuevo`) de la empresa `companyId`. Devuelve un objeto
 * plano (no `Response`) listo para que el tool del bot lo entregue a Gemini.
 * `order_number` lo asigna el trigger por empresa.
 */
export async function createBotOrder(input: CreateBotOrderInput): Promise<CreateBotOrderResult> {
  const sb = supabaseAdmin();
  const { companyId } = input;

  // 1. Resolver productos (solo de la empresa).
  const productIds = input.items.map(i => i.productId);
  const { data: products, error: prodErr } = await sb
    .from('products')
    .select('id, name, price, available')
    .eq('company_id', companyId)
    .in('id', productIds);
  if (prodErr) return { ok: false, error: prodErr.message };

  const productById = new Map((products ?? []).map(p => [p.id, p]));
  const unavailable: string[] = [];
  let subtotal = 0;
  const itemsToInsert: Array<{ product_id: string; qty: number; price_at_order: number }> = [];

  for (const it of input.items) {
    const p = productById.get(it.productId);
    if (!p) return { ok: false, error: `Producto no existe: ${it.productId}` };
    if (!p.available) {
      unavailable.push(p.name);
      continue;
    }
    subtotal += p.price * it.qty;
    itemsToInsert.push({ product_id: p.id, qty: it.qty, price_at_order: p.price });
  }
  if (unavailable.length > 0) {
    return { ok: false, error: 'Algunos productos no están disponibles', unavailable };
  }

  // 2. Verificar zona (de la empresa) y calcular total.
  const { data: zone, error: zErr } = await sb
    .from('zones')
    .select('id, name, tarifa, lat, lng')
    .eq('company_id', companyId)
    .eq('id', input.zoneId)
    .single();
  if (zErr || !zone) return { ok: false, error: `Zona no existe: ${input.zoneId}` };

  const delivery = zone.tarifa as number;
  const total = subtotal + delivery;

  // 3. Upsert customer por (company_id, phone) — único por empresa.
  const { data: customer, error: custErr } = await sb
    .from('customers')
    .upsert(
      {
        company_id: companyId,
        name: input.customerName,
        phone: input.phone,
        addr: input.address,
        zone_id: input.zoneId,
        tag: 'Nuevo',
      },
      { onConflict: 'company_id,phone' },
    )
    .select('id')
    .single();
  if (custErr || !customer) {
    return { ok: false, error: custErr?.message ?? 'customer error' };
  }

  // 4. Insertar order (order_number lo pone el trigger por empresa).
  const { data: order, error: ordErr } = await sb
    .from('orders')
    .insert({
      company_id: companyId,
      customer_id: customer.id,
      total,
      zone_id: input.zoneId,
      status: 'nuevo',
      address: input.address,
      phone: input.phone,
      payment_method: input.paymentMethod,
      note: input.note ?? null,
      lat: input.lat ?? zone.lat,
      lng: input.lng ?? zone.lng,
      sales_channel: 'whatsapp',
    })
    .select('id, order_number')
    .single();
  if (ordErr || !order) {
    return { ok: false, error: ordErr?.message ?? 'order error' };
  }

  // 5. Insertar order_items (con company_id denormalizado para RLS/joins).
  const itemsWithOrderId = itemsToInsert.map(i => ({
    ...i,
    order_id: order.id,
    company_id: companyId,
  }));
  const { error: itemsErr } = await sb.from('order_items').insert(itemsWithOrderId);
  if (itemsErr) return { ok: false, error: itemsErr.message };

  // 5b. Post-venta: canje de cupón de postre (scopeado por empresa).
  await redeemRewardForOrder({ sb, orderId: order.id, phone: input.phone, companyId });

  // 6. Link de pago (mock; se reemplaza por Wompi real por empresa).
  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'http://localhost:3000';
  const paymentLink = `${origin}/wompi/checkout/${order.id}`;

  return {
    ok: true,
    orderId: order.id,
    orderNumber: order.order_number ?? null,
    subtotal,
    delivery,
    total,
    paymentLink,
  };
}

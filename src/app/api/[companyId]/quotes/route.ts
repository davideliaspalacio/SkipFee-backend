import { z } from 'zod';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string(),
        qty: z.number().int().positive().max(99),
      }),
    )
    .min(1)
    .max(50),
  zoneId: z.string().optional(),
});

/**
 * POST /api/<companyId>/quotes — cotiza un pedido de LA empresa:
 * subtotal + domicilio + recargo hora pico.
 *
 * Estrategia de domicilio (decisión §3 del PLAN, refinada en reunión con cliente):
 * 1. Si `zoneId` conocido → zone.tarifa
 * 2. Si no → settings.base_delivery_fee (tarifa base mínima tipo taxi)
 *
 * Recargo hora pico: si la hora actual (Bogotá) está dentro de
 * settings.peak_start..peak_end, sumar zone.recargo (o settings.peak_surcharge si no hay zona).
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

  // 1. Productos solicitados — verificar disponibilidad y precios (de la empresa)
  const productIds = parsed.items.map(i => i.productId);
  const { data: products, error: prodErr } = await sb
    .from('products')
    .select('id, name, price, available')
    .eq('company_id', companyId)
    .in('id', productIds);

  if (prodErr) {
    console.error('[quotes] products query error', prodErr);
    return Response.json({ ok: false, error: prodErr.message }, { status: 500 });
  }

  const productById = new Map((products ?? []).map(p => [p.id, p]));
  const unavailable: string[] = [];
  const itemsResolved: Array<{
    productId: string;
    name: string;
    price: number;
    qty: number;
    subtotal: number;
  }> = [];
  let subtotal = 0;

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
    const lineSubtotal = p.price * it.qty;
    subtotal += lineSubtotal;
    itemsResolved.push({
      productId: p.id,
      name: p.name,
      price: p.price,
      qty: it.qty,
      subtotal: lineSubtotal,
    });
  }

  if (unavailable.length > 0) {
    return Response.json(
      {
        ok: false,
        error: 'Algunos productos no están disponibles',
        unavailable,
      },
      { status: 409 },
    );
  }

  // 2. Cargar settings de la empresa
  const { data: settings, error: setErr } = await sb
    .from('settings')
    .select('base_delivery_fee')
    .eq('company_id', companyId)
    .single();

  if (setErr || !settings) {
    console.error('[quotes] settings query error', setErr);
    return Response.json({ ok: false, error: 'Settings no inicializado' }, { status: 500 });
  }

  // 3. Cargar zona si se proveyó (de la empresa)
  let zone: { id: string; name: string; tarifa: number } | null = null;
  if (parsed.zoneId) {
    const { data: z, error: zErr } = await sb
      .from('zones')
      .select('id, name, tarifa')
      .eq('company_id', companyId)
      .eq('id', parsed.zoneId)
      .single();
    if (zErr || !z) {
      return Response.json(
        { ok: false, error: `Zona no existe: ${parsed.zoneId}` },
        { status: 400 },
      );
    }
    zone = z;
  }

  // 4. Calcular domicilio (hora pico eliminada: sin recargo)
  const baseDelivery = zone ? zone.tarifa : settings.base_delivery_fee;
  const peakSurcharge = 0;
  const total = subtotal + baseDelivery + peakSurcharge;

  return Response.json({
    ok: true,
    subtotal,
    delivery: baseDelivery,
    peakSurcharge,
    total,
    isPeakHour: false,
    zone: zone ? { id: zone.id, name: zone.name } : null,
    items: itemsResolved,
  });
});

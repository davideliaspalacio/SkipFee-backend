import { serializeOrder } from '@/lib/serializers';
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

/**
 * GET /api/<companyId>/orders/[id]
 * Devuelve un pedido individual (de LA empresa) serializado a la forma del
 * frontend. Lo consume el detalle del kanban (panel lateral derecho).
 *
 * Aislamiento: `ctx.db` (JWT del usuario → RLS = capa 2) + filtro explícito por
 * `company_id` (capa 1).
 */
export const GET = withTenant<{ companyId: string; id: string }>(async (_request, ctx, params) => {
  const { id } = params;

  const { data, error } = await ctx.db
    .from('orders')
    .select(ORDER_SELECT)
    .eq('company_id', ctx.company.id)
    .eq('id', id)
    .single();

  if (error || !data) {
    return Response.json(
      { ok: false, error: 'Pedido no encontrado' },
      { status: 404 },
    );
  }

  return Response.json({ ok: true, order: serializeOrder(data) });
});

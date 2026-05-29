import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { serializeOrder } from '@/lib/serializers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ORDER_SELECT = `
  id, total, status, address, phone, payment_method, note, lat, lng, created_at,
  customer:customers(id, name),
  zone:zones(id, name),
  items:order_items(qty, product:products(name))
`;

/**
 * GET /api/orders/[id]
 * Devuelve un pedido individual serializado a la forma del frontend.
 * Lo consume el detalle del kanban (panel lateral derecho).
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  const { data, error } = await supabaseAdmin()
    .from('orders')
    .select(ORDER_SELECT)
    .eq('id', id)
    .single();

  if (error || !data) {
    return Response.json(
      { ok: false, error: 'Pedido no encontrado' },
      { status: 404 },
    );
  }

  return Response.json({ ok: true, order: serializeOrder(data) });
}

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { aggregateOrdersByCustomer, deriveCustomerTag } from '@/lib/customer-stats';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DerivedTag = 'VIP' | 'Recurrente' | 'Nuevo';
const TAGS: readonly DerivedTag[] = ['VIP', 'Recurrente', 'Nuevo'];

/**
 * GET /api/customers?tag=&search=&limit=
 * Lista clientes para la pantalla Clientes del panel.
 *
 * `pedidos`, `ticket promedio`, `ultimo` y `tag` se computan al vuelo desde
 * `orders.status='entregado'` — las columnas pre-computadas de la tabla
 * `customers` no se mantienen actualizadas y se ignoran.
 *
 * - tag: filtra por VIP | Recurrente | Nuevo (derivado de pedidos entregados)
 * - search: substring match contra name o phone (case-insensitive)
 * - limit: máximo 500, default 200
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const tagParam = url.searchParams.get('tag');
  const tag = TAGS.includes(tagParam as DerivedTag) ? (tagParam as DerivedTag) : null;
  const search = url.searchParams.get('search')?.trim();
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 200, 500) : 200;

  let query = supabaseAdmin()
    .from('customers')
    .select('id, name, phone, addr, zone_id');

  if (search) {
    query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
  }

  const { data: rows, error } = await query;
  if (error) {
    console.error('[customers GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const ids = (rows ?? []).map(r => r.id);
  const stats = await aggregateOrdersByCustomer(ids);

  const enriched = (rows ?? []).map(c => {
    const s = stats.get(c.id);
    const pedidos = s?.pedidos ?? 0;
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      addr: c.addr,
      zone: c.zone_id,
      pedidos,
      ticket: s?.ticket ?? 0,
      ultimo: s?.ultimo ?? null,
      tag: deriveCustomerTag(pedidos),
    };
  });

  const filtered = tag ? enriched.filter(c => c.tag === tag) : enriched;
  filtered.sort((a, b) => b.pedidos - a.pedidos);
  const customers = filtered.slice(0, limit);

  return Response.json({ ok: true, customers });
}

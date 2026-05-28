import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/customers?tag=&search=&limit=
 * Lista clientes para la pantalla Clientes del panel.
 * Devuelve forma camelCase compatible con el tipo Customer del frontend.
 *
 * - tag: filtra por VIP | Recurrente | Nuevo
 * - search: substring match contra name o phone (case-insensitive)
 * - limit: máximo 500, default 200
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const tag = url.searchParams.get('tag');
  const search = url.searchParams.get('search')?.trim();
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 200, 500) : 200;

  let query = supabaseAdmin()
    .from('customers')
    .select('id, name, phone, addr, zone_id, pedidos, ticket, ultimo, rating, tag')
    .order('pedidos', { ascending: false })
    .limit(limit);

  if (tag) query = query.eq('tag', tag);
  if (search) {
    // ILIKE para case-insensitive; busca en nombre OR teléfono.
    query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[customers GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Serialización: zone_id → zone (la forma que espera el frontend)
  const customers = (data ?? []).map(c => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
    addr: c.addr,
    zone: c.zone_id,
    pedidos: c.pedidos,
    ticket: c.ticket,
    ultimo: c.ultimo,
    rating: c.rating,
    tag: c.tag,
  }));

  return Response.json({ ok: true, customers });
}

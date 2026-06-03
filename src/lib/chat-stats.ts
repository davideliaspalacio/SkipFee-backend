import { supabaseAdmin } from './db';

export interface ChatStats {
  prevOrders: number;
  avgTicket: number;
}

/**
 * Calcula pedidos previos y ticket promedio por teléfono.
 * Solo cuenta pedidos en estado `entregado` — el panel de WhatsApp muestra
 * "previos" en el sentido de pedidos cerrados, no en curso.
 *
 * Devuelve un Map<phone, stats>. Los teléfonos sin pedidos no aparecen en el
 * map (el caller asume defaults a 0).
 */
export async function chatStatsByPhone(phones: string[]): Promise<Map<string, ChatStats>> {
  const result = new Map<string, ChatStats>();
  if (phones.length === 0) return result;

  const { data, error } = await supabaseAdmin()
    .from('orders')
    .select('phone, total')
    .eq('status', 'entregado')
    .in('phone', phones);

  if (error) throw error;

  const buckets = new Map<string, { count: number; sum: number }>();
  for (const row of data ?? []) {
    const b = buckets.get(row.phone) ?? { count: 0, sum: 0 };
    b.count += 1;
    b.sum += row.total;
    buckets.set(row.phone, b);
  }

  for (const [phone, { count, sum }] of buckets) {
    result.set(phone, {
      prevOrders: count,
      avgTicket: count > 0 ? Math.round(sum / count) : 0,
    });
  }

  return result;
}

import { supabaseAdmin } from './db';

export interface CustomerStats {
  pedidos: number;
  ticket: number;
  ultimo: string | null;
}

/**
 * Agrega pedidos entregados por cliente: cuenta, ticket promedio y fecha
 * (ISO) del último pedido. Misma convención que `chat-stats.ts` —
 * solo cuentan los pedidos `entregado`, para no inflar con pedidos
 * en curso que puedan cancelarse.
 *
 * Devuelve un Map<customerId, stats>. Los clientes sin pedidos
 * entregados no aparecen; el caller asume defaults a 0 / null.
 */
export async function aggregateOrdersByCustomer(
  customerIds: string[],
): Promise<Map<string, CustomerStats>> {
  const result = new Map<string, CustomerStats>();
  if (customerIds.length === 0) return result;

  const { data, error } = await supabaseAdmin()
    .from('orders')
    .select('customer_id, total, created_at')
    .eq('status', 'entregado')
    .in('customer_id', customerIds);

  if (error) throw error;

  const buckets = new Map<string, { count: number; sum: number; ultimo: string | null }>();
  for (const row of data ?? []) {
    const b = buckets.get(row.customer_id) ?? { count: 0, sum: 0, ultimo: null };
    b.count += 1;
    b.sum += row.total;
    if (!b.ultimo || row.created_at > b.ultimo) b.ultimo = row.created_at;
    buckets.set(row.customer_id, b);
  }

  for (const [id, { count, sum, ultimo }] of buckets) {
    result.set(id, {
      pedidos: count,
      ticket: count > 0 ? Math.round(sum / count) : 0,
      ultimo,
    });
  }

  return result;
}

/** Deriva la etiqueta de un cliente a partir de su histórico de pedidos entregados. */
export function deriveCustomerTag(pedidos: number): 'VIP' | 'Recurrente' | 'Nuevo' {
  if (pedidos > 10) return 'VIP';
  if (pedidos >= 2) return 'Recurrente';
  return 'Nuevo';
}

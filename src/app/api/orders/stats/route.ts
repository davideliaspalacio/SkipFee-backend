import { supabaseAdmin } from '@/lib/db';
import { ACTIVE_STATUSES, startOfTodayInBogota } from '@/lib/orders-stats';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/orders/stats
 * Contadores ligeros para el header del kanban:
 *   - active:         pedidos creados hoy que siguen activos (ver ACTIVE_STATUSES)
 *   - completedToday: pedidos entregados hoy
 *
 * Una sola query trae solo `status` de los pedidos del día, agregamos en memoria.
 * Pensado para polling frecuente desde el header de Pedidos.
 */
export async function GET() {
  const sb = supabaseAdmin();
  const todayStart = startOfTodayInBogota();

  const { data, error } = await sb
    .from('orders')
    .select('status')
    .gte('created_at', todayStart.toISOString());

  if (error) {
    console.error('[orders/stats GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{ status: string }>;
  let active = 0;
  let completedToday = 0;
  for (const r of rows) {
    if (r.status === 'entregado') completedToday += 1;
    else if (ACTIVE_STATUSES.includes(r.status)) active += 1;
  }

  return Response.json({ ok: true, active, completedToday });
}

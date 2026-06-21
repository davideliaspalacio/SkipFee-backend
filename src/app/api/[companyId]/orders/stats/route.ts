import { ACTIVE_STATUSES, startOfTodayInBogota } from '@/lib/orders-stats';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/<companyId>/orders/stats
 * Contadores ligeros para el header del kanban + el badge del sidebar (de LA
 * empresa):
 *   - active:         pedidos activos AHORA (cualquier fecha, status ∈ ACTIVE_STATUSES).
 *                     Coincide con lo que aparece en el kanban — incluye pedidos
 *                     iniciados ayer que siguen sin entregarse.
 *   - completedToday: pedidos entregados hoy (Bogotá).
 *
 * Dos queries en paralelo, ambas devuelven solo `id` para minimizar payload.
 * Aislamiento: `ctx.db` (RLS = capa 2) + `company_id` (capa 1).
 */
export const GET = withTenant(async (_request, ctx) => {
  const sb = ctx.db;
  const companyId = ctx.company.id;
  const todayStart = startOfTodayInBogota();

  const [activeRes, completedRes] = await Promise.all([
    sb.from('orders').select('id').eq('company_id', companyId).in('status', ACTIVE_STATUSES),
    sb
      .from('orders')
      .select('id')
      .eq('company_id', companyId)
      .eq('status', 'entregado')
      .gte('created_at', todayStart.toISOString()),
  ]);

  if (activeRes.error || completedRes.error) {
    const err = activeRes.error ?? completedRes.error;
    console.error('[orders/stats GET] error', err);
    return Response.json({ ok: false, error: err?.message ?? 'unknown' }, { status: 500 });
  }

  return Response.json({
    ok: true,
    active: activeRes.data?.length ?? 0,
    completedToday: completedRes.data?.length ?? 0,
  });
});

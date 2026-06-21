import { ACTIVE_STATUSES, startOfTodayInBogota } from '@/lib/orders-stats';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ATTENTION_MINUTES = 30;
const PALETTE = ['#E85D04', '#606C38', '#5E6AD2', '#A16207', '#0EA5E9', '#15803D'];

const DAY_ABBR = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

interface OrderRow {
  id: string;
  order_number: number;
  total: number;
  status: string;
  created_at: string;
  address: string;
  phone: string;
  customer: { name: string } | { name: string }[] | null;
}

function pickOne<T>(value: T | T[] | null): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * GET /api/<companyId>/dashboard/today
 * Devuelve KPIs y agregaciones para la pantalla Dashboard de LA empresa.
 * Una sola consulta agrega los últimos 7 días y filtramos en memoria.
 */
export const GET = withTenant(async (_request, ctx) => {
  const sb = ctx.db;
  const todayStart = startOfTodayInBogota();
  const sevenDaysAgo = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);

  // Una sola query con los pedidos de los últimos 7 días
  const { data: orders, error: ordersErr } = await sb
    .from('orders')
    .select('id, order_number, total, status, created_at, address, phone, customer:customers(name)')
    .eq('company_id', ctx.company.id)
    .gte('created_at', sevenDaysAgo.toISOString())
    .order('created_at', { ascending: false });

  if (ordersErr) {
    console.error('[dashboard GET] orders error', ordersErr);
    return Response.json({ ok: false, error: ordersErr.message }, { status: 500 });
  }

  const allOrders = (orders ?? []) as OrderRow[];

  // ----- KPIs del día (solo entregados/completados cuentan en ventas) -----
  const todayOrders = allOrders.filter(o => new Date(o.created_at) >= todayStart);
  const todayCompleted = todayOrders.filter(o => o.status === 'entregado');
  const todayActive = todayOrders.filter(o => ACTIVE_STATUSES.includes(o.status));

  const salesAmount = todayCompleted.reduce((sum, o) => sum + (o.total || 0), 0);
  const completedOrders = todayCompleted.length;
  const activeOrders = todayActive.length;
  const avgTicket = todayCompleted.length > 0
    ? Math.round(salesAmount / todayCompleted.length)
    : 0;

  // ----- Sales últimos 7 días (agrupado por día) -----
  const buckets = new Map<string, { sales: number; orders: number }>();
  for (let i = 0; i < 7; i++) {
    const day = new Date(todayStart.getTime() - i * 24 * 60 * 60 * 1000);
    const key = day.toISOString().slice(0, 10);
    buckets.set(key, { sales: 0, orders: 0 });
  }
  for (const o of allOrders) {
    if (o.status !== 'entregado') continue;
    const key = new Date(o.created_at).toISOString().slice(0, 10);
    const b = buckets.get(key);
    if (b) {
      b.sales += o.total || 0;
      b.orders += 1;
    }
  }
  const sales7d = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, b]) => {
      const d = new Date(key + 'T05:00:00Z');
      return {
        day: DAY_ABBR[d.getUTCDay()],
        sales: b.sales,
        orders: b.orders,
      };
    });

  // ----- Top productos vendidos hoy (mix donut) -----
  const todayOrderIds = todayOrders.map(o => o.id);
  let productMix: Array<{ name: string; value: number; color: string }> = [];
  if (todayOrderIds.length > 0) {
    const { data: items, error: itemsErr } = await sb
      .from('order_items')
      .select('qty, product:products(name)')
      .eq('company_id', ctx.company.id)
      .in('order_id', todayOrderIds);

    if (!itemsErr && items) {
      const counts = new Map<string, number>();
      for (const it of items) {
        const product = pickOne(it.product) as { name: string } | null;
        const name = product?.name ?? 'Otro';
        counts.set(name, (counts.get(name) ?? 0) + (it.qty || 0));
      }
      productMix = Array.from(counts.entries())
        .sort(([, a], [, b]) => b - a)
        .slice(0, 6)
        .map(([name, value], i) => ({ name, value, color: PALETTE[i % PALETTE.length] }));
    }
  }

  // ----- Pedidos que requieren atención (>30 min en estado activo) -----
  const now = Date.now();
  const attentionOrders = todayActive
    .map(o => {
      const minutes = Math.floor((now - new Date(o.created_at).getTime()) / 60000);
      return { ...o, minutes };
    })
    .filter(o => o.minutes >= ATTENTION_MINUTES)
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 4)
    .map(o => ({
      id: o.id,
      number: o.order_number,
      cliente: pickOne(o.customer as OrderRow['customer'])?.name ?? '—',
      status: o.status,
      minutos: o.minutes,
      reason:
        o.minutes >= 60
          ? 'Lleva más de una hora sin moverse'
          : `${o.minutes} min en estado ${o.status}`,
    }));

  return Response.json({
    ok: true,
    salesAmount,
    completedOrders,
    activeOrders,
    avgTicket,
    sales7d,
    productMix,
    attentionOrders,
  });
});

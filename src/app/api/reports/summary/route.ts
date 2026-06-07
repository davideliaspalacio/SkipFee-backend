import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface OrderRow {
  id: string;
  total: number;
  status: string;
  created_at: string;
  zone_id: string;
}

interface ItemRow {
  qty: number;
  order_id: string;
  product: { id: string; name: string } | { id: string; name: string }[] | null;
}

interface ZoneRow {
  id: string;
  name: string;
  tarifa: number;
  recargo: number;
}

function pickOne<T>(value: T | T[] | null): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function periodDays(period: string): number {
  if (period === '7d') return 7;
  if (period === '90d') return 90;
  return 30;
}

/**
 * GET /api/reports/summary?period=7d|30d|90d
 * Devuelve agregaciones para la pantalla Reportes.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const period = url.searchParams.get('period') ?? '30d';
  const days = periodDays(period);
  const now = new Date();
  const periodStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const prevPeriodStart = new Date(periodStart.getTime() - days * 24 * 60 * 60 * 1000);

  const sb = supabaseAdmin();

  // 1. Pedidos del período actual + el período anterior (para comparación)
  const [{ data: currentOrders }, { data: prevOrders }, { data: zonesData }] = await Promise.all([
    sb
      .from('orders')
      .select('id, total, status, created_at, zone_id')
      .gte('created_at', periodStart.toISOString())
      .lte('created_at', now.toISOString()),
    sb
      .from('orders')
      .select('id, total, status, created_at, zone_id')
      .gte('created_at', prevPeriodStart.toISOString())
      .lt('created_at', periodStart.toISOString()),
    sb.from('zones').select('id, name, tarifa, recargo'),
  ]);

  const current = (currentOrders ?? []) as OrderRow[];
  const previous = (prevOrders ?? []) as OrderRow[];
  const zones = (zonesData ?? []) as ZoneRow[];
  const zoneById = new Map(zones.map(z => [z.id, z]));

  const completed = current.filter(o => o.status === 'entregado');
  const completedPrev = previous.filter(o => o.status === 'entregado');

  // 2. Financial — bruto, domicilios estimados, comisiones, neto
  const bruto = completed.reduce((s, o) => s + (o.total || 0), 0);
  const domicilios = completed.reduce((s, o) => {
    const z = zoneById.get(o.zone_id);
    return s + (z?.tarifa ?? 0);
  }, 0);
  const neto = bruto - domicilios;
  const brutoPrev = completedPrev.reduce((s, o) => s + (o.total || 0), 0);
  const variation = brutoPrev > 0 ? Math.round(((bruto - brutoPrev) / brutoPrev) * 1000) / 10 : 0;

  // 3. Weekly comparison — 7 días esta semana vs anterior
  const weeklyBuckets = Array.from({ length: 7 }, (_, i) => ({
    label: ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'][i],
    thisMonth: 0,
    lastMonth: 0,
  }));
  for (const o of completed) {
    const day = new Date(o.created_at).getDay();
    weeklyBuckets[day].thisMonth += o.total || 0;
  }
  for (const o of completedPrev) {
    const day = new Date(o.created_at).getDay();
    weeklyBuckets[day].lastMonth += o.total || 0;
  }

  // 4. Top productos en el período
  const currentIds = current.map(o => o.id);
  let topProducts: Array<{ id: string; name: string; sold: number }> = [];
  if (currentIds.length > 0) {
    const { data: items } = await sb
      .from('order_items')
      .select('qty, order_id, product:products(id, name)')
      .in('order_id', currentIds);

    if (items) {
      const counts = new Map<string, { name: string; sold: number }>();
      for (const it of items as ItemRow[]) {
        const p = pickOne(it.product);
        if (!p) continue;
        const cur = counts.get(p.id) ?? { name: p.name, sold: 0 };
        cur.sold += it.qty || 0;
        counts.set(p.id, cur);
      }
      topProducts = Array.from(counts.entries())
        .sort(([, a], [, b]) => b.sold - a.sold)
        .slice(0, 8)
        .map(([id, v]) => ({ id, name: v.name, sold: v.sold }));
    }
  }

  // 5. Zone analysis
  const zoneAggregate = new Map<string, { orders: number; revenue: number }>();
  for (const o of completed) {
    const cur = zoneAggregate.get(o.zone_id) ?? { orders: 0, revenue: 0 };
    cur.orders += 1;
    cur.revenue += o.total || 0;
    zoneAggregate.set(o.zone_id, cur);
  }
  const zoneAnalysis = zones.map(z => {
    const agg = zoneAggregate.get(z.id) ?? { orders: 0, revenue: 0 };
    return {
      zone: z.id,
      zoneName: z.name,
      orders: agg.orders,
      revenue: agg.revenue,
      avgTicket: agg.orders > 0 ? Math.round(agg.revenue / agg.orders) : 0,
      deliveryCost: agg.orders * z.tarifa,
    };
  });

  // 6. Heatmap 7 días × 12 franjas horarias (11am-11pm)
  const heatmap: number[][] = Array.from({ length: 7 }, () => Array(12).fill(0));
  for (const o of completed) {
    const d = new Date(o.created_at);
    const day = d.getDay();
    const hour = d.getHours() - 11; // 11am=0, 12pm=1, ..., 10pm=11
    if (hour >= 0 && hour < 12) {
      heatmap[day][hour] += 1;
    }
  }
  // Normalizar a 0-1 para que el frontend pinte intensidades comparables
  const maxCell = Math.max(1, ...heatmap.flat());
  const heatmapNorm = heatmap.map(row => row.map(v => +(v / maxCell).toFixed(2)));

  // 7. Conversion (chats vs pedidos) — usamos current snapshot
  const { count: openChatsCount } = await sb
    .from('chats')
    .select('*', { count: 'exact', head: true });
  const closedOrders = completed.length;
  const totalChats = openChatsCount ?? 0;
  const nonConverted = Math.max(0, totalChats - closedOrders);
  const conversionRate = totalChats > 0 ? Math.round((closedOrders / totalChats) * 100) : 0;

  return Response.json({
    ok: true,
    period,
    financial: { bruto, domicilios, neto, variation },
    weeklyComparison: weeklyBuckets,
    topProducts,
    zoneAnalysis,
    heatmap: heatmapNorm,
    conversion: {
      openChats: totalChats,
      closedOrders,
      nonConverted,
      rate: conversionRate,
    },
  });
}

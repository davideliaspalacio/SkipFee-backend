import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/surveys?ratingMax=3&days=14  (Tarea 3)
 *
 * Encuestas YA respondidas, filtradas por nota máxima (default ≤3) dentro de una
 * ventana de días. Alimenta la alerta del panel de "calificaciones bajas" (los
 * casos que pasaron a un humano). Enriquece con el nombre del cliente por phone.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const ratingMax = Number(url.searchParams.get('ratingMax') ?? '3');
  const days = Number(url.searchParams.get('days') ?? '14');
  const since = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();

  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from('order_surveys')
    .select('id, order_id, phone, rating, comment, responded_at')
    .not('rating', 'is', null)
    .lte('rating', Number.isFinite(ratingMax) ? ratingMax : 3)
    .gte('responded_at', since)
    .order('responded_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('[surveys GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{
    id: string; order_id: string; phone: string; rating: number; comment: string | null; responded_at: string;
  }>;

  // Enriquecer con el nombre del cliente (una query para todos los phones).
  const phones = [...new Set(rows.map(r => r.phone))];
  const names = new Map<string, string>();
  if (phones.length > 0) {
    const { data: customers } = await sb.from('customers').select('phone, name').in('phone', phones);
    for (const c of (customers ?? []) as Array<{ phone: string; name: string }>) {
      names.set(c.phone, c.name);
    }
  }

  const surveys = rows.map(r => ({
    id: r.id,
    orderId: r.order_id,
    phone: r.phone,
    name: names.get(r.phone) ?? null,
    rating: r.rating,
    comment: r.comment,
    respondedAt: r.responded_at,
  }));
  return Response.json({ ok: true, surveys });
}

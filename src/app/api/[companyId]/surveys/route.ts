import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/<companyId>/surveys?days=90[&ratingMax=3]  (Tarea 3)
 *
 * Encuestas YA respondidas de LA empresa dentro de una ventana de días. Sin
 * `ratingMax` devuelve TODAS (reporte de reseñas en Configuración); con
 * `ratingMax` filtra (ej. ≤3 para los casos que pasaron a un humano). Enriquece
 * con el nombre del cliente.
 */
export const GET = withTenant(async (request, ctx) => {
  const url = new URL(request.url);
  const ratingMaxParam = url.searchParams.get('ratingMax');
  const ratingMax = ratingMaxParam != null ? Number(ratingMaxParam) : null;
  const days = Number(url.searchParams.get('days') ?? '90');
  const since = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();

  const sb = ctx.db;
  const companyId = ctx.company.id;
  let query = sb
    .from('order_surveys')
    .select('id, order_id, phone, rating, comment, responded_at')
    .eq('company_id', companyId)
    .not('rating', 'is', null)
    .gte('responded_at', since)
    .order('responded_at', { ascending: false })
    .limit(200);
  if (ratingMax != null && Number.isFinite(ratingMax)) {
    query = query.lte('rating', ratingMax);
  }
  const { data, error } = await query;

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
    const { data: customers } = await sb
      .from('customers')
      .select('phone, name')
      .eq('company_id', companyId)
      .in('phone', phones);
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
});

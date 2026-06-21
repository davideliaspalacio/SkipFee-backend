import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/<companyId>/rewards?status=pendiente  (Tarea 3)
 *
 * Cola de cupones de LA empresa. Por defecto los 'pendiente' (reseñas por
 * verificar). Acepta ?status=otorgado|canjeado|expirado|rechazado.
 */
const VALID = ['pendiente', 'otorgado', 'canjeado', 'expirado', 'rechazado'];

export const GET = withTenant(async (request, ctx) => {
  const statusParam = new URL(request.url).searchParams.get('status') ?? 'pendiente';
  const status = VALID.includes(statusParam) ? statusParam : 'pendiente';

  const { data, error } = await ctx.db
    .from('rewards')
    .select('id, phone, kind, status, order_id_origen, screenshot_url, created_at, granted_at, granted_by, expires_at')
    .eq('company_id', ctx.company.id)
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    console.error('[rewards GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rewards = (data ?? []).map(r => ({
    id: r.id,
    phone: r.phone,
    kind: r.kind,
    status: r.status,
    orderIdOrigen: r.order_id_origen,
    screenshotUrl: r.screenshot_url,
    createdAt: r.created_at,
    grantedAt: r.granted_at,
    grantedBy: r.granted_by,
    expiresAt: r.expires_at,
  }));
  return Response.json({ ok: true, rewards });
});

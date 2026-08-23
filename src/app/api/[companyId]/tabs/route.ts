import { withTenant } from '@/lib/tenant';
import { listOpenTabs, tabErrorResponse } from '@/lib/dinein-tabs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/<companyId>/tabs — cuentas de mesa abiertas (abierta|por_cobrar) de
 * LA empresa. Alimenta la vista "Salón" en vivo. Privado (panel).
 */
export const GET = withTenant(async (_request, ctx) => {
  try {
    const tabs = await listOpenTabs(ctx.db, ctx.company.id);
    return Response.json({ ok: true, tabs });
  } catch (err) {
    return tabErrorResponse(err);
  }
});

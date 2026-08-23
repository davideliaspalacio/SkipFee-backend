import { withTenant } from '@/lib/tenant';
import { sendTabToKitchen, tabErrorResponse } from '@/lib/dinein-tabs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/<companyId>/tabs/[orderId]/send-kitchen — manda a cocina los ítems
 * pendientes de la cuenta (kitchen_status pendiente → en_cocina).
 */
export const POST = withTenant<{ companyId: string; orderId: string }>(async (_request, ctx, params) => {
  try {
    const tab = await sendTabToKitchen(ctx.db, ctx.company.id, params.orderId);
    return Response.json({ ok: true, tab });
  } catch (err) {
    return tabErrorResponse(err);
  }
});

import { z } from 'zod';
import { withTenant } from '@/lib/tenant';
import { openTab, tabErrorResponse } from '@/lib/dinein-tabs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ waiterId: z.string().optional() });

/**
 * POST /api/<companyId>/tables/[id]/open — abre una cuenta en la mesa (o
 * devuelve la que ya esté abierta). Body opcional: { waiterId }.
 */
export const POST = withTenant<{ companyId: string; id: string }>(async (request, ctx, params) => {
  let body: { waiterId?: string } = {};
  try {
    const raw = await request.text();
    if (raw) body = bodySchema.parse(JSON.parse(raw));
  } catch {
    // body es opcional; ignoramos errores de parseo y abrimos sin mesero.
  }

  try {
    const tab = await openTab(ctx.db, ctx.company.id, params.id, body.waiterId ?? null);
    return Response.json({ ok: true, tab }, { status: 201 });
  } catch (err) {
    return tabErrorResponse(err);
  }
});

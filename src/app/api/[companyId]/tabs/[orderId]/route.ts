import { z } from 'zod';
import { withTenant } from '@/lib/tenant';
import { getTab, updateTab, tabErrorResponse } from '@/lib/dinein-tabs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/<companyId>/tabs/[orderId] — detalle de una cuenta de mesa. */
export const GET = withTenant<{ companyId: string; orderId: string }>(async (_request, ctx, params) => {
  try {
    const tab = await getTab(ctx.db, ctx.company.id, params.orderId);
    return Response.json({ ok: true, tab });
  } catch (err) {
    return tabErrorResponse(err);
  }
});

const patchSchema = z.object({
  status: z.enum(['abierta', 'por_cobrar', 'cerrada']).optional(),
  waiterId: z.string().nullable().optional(),
  tip: z.number().int().min(0).optional(),
});

/**
 * PATCH /api/<companyId>/tabs/[orderId] — cambia estado (pedir la cuenta /
 * cerrar), mesero asignado o propina.
 */
export const PATCH = withTenant<{ companyId: string; orderId: string }>(async (request, ctx, params) => {
  let body;
  try {
    body = patchSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const tab = await updateTab(ctx.db, ctx.company.id, params.orderId, body);
    return Response.json({ ok: true, tab });
  } catch (err) {
    return tabErrorResponse(err);
  }
});

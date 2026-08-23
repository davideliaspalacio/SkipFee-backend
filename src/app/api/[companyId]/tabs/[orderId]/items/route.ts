import { z } from 'zod';
import { withTenant } from '@/lib/tenant';
import { addTabItems, tabErrorResponse } from '@/lib/dinein-tabs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        qty: z.number().int().min(1).max(99),
        note: z.string().max(200).nullable().optional(),
      }),
    )
    .min(1),
});

/**
 * POST /api/<companyId>/tabs/[orderId]/items — agrega ítems a la cuenta (una
 * ronda). Quedan en cocina='pendiente' hasta enviarlos con /send-kitchen.
 */
export const POST = withTenant<{ companyId: string; orderId: string }>(async (request, ctx, params) => {
  let body;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const tab = await addTabItems(ctx.db, ctx.company.id, params.orderId, body.items);
    return Response.json({ ok: true, tab }, { status: 201 });
  } catch (err) {
    return tabErrorResponse(err);
  }
});

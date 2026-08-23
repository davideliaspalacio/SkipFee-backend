import { z } from 'zod';
import { withTenant } from '@/lib/tenant';
import { getSplitView, registerCashShare } from '@/lib/dinein-split';
import { tabErrorResponse } from '@/lib/dinein-tabs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/<companyId>/tabs/[orderId]/split — estado del split (recaudado/falta/porciones). */
export const GET = withTenant<{ companyId: string; orderId: string }>(async (_request, ctx, params) => {
  try {
    const split = await getSplitView(ctx.db, ctx.company.id, params.orderId);
    return Response.json({ ok: true, split });
  } catch (err) {
    return tabErrorResponse(err);
  }
});

const cashSchema = z.object({
  amount: z.number().int().positive(),
  method: z.enum(['efectivo', 'datafono']),
  label: z.string().max(60).optional(),
});

/**
 * POST /api/<companyId>/tabs/[orderId]/split — registra un pago presencial
 * (efectivo/datáfono) del mesero. Queda 'pagado' al instante y cierra la cuenta
 * si con eso se completa el total.
 */
export const POST = withTenant<{ companyId: string; orderId: string }>(async (request, ctx, params) => {
  let body;
  try {
    body = cashSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const split = await registerCashShare(
      ctx.db,
      ctx.company.id,
      params.orderId,
      body.amount,
      body.method,
      body.label ?? null,
    );
    return Response.json({ ok: true, split }, { status: 201 });
  } catch (err) {
    return tabErrorResponse(err);
  }
});

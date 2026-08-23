import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { jsonWithCors, preflight } from '@/lib/checkout/cors';
import { addTabItems, DineInError } from '@/lib/dinein-tabs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/checkout/tab/:orderId/items   (público — autoservicio por QR)
 *
 * Agrega ítems a la cuenta de la mesa (una ronda). Quedan 'pendiente' hasta que
 * se envíen a cocina con /send-kitchen.
 */
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

export async function POST(request: NextRequest, ctx: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await ctx.params;

  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) return jsonWithCors({ ok: false, errors: err.issues }, 400);
    return jsonWithCors({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const sb = supabaseAdmin();
  const { data: ord } = await sb
    .from('orders')
    .select('company_id, order_type')
    .eq('id', orderId)
    .maybeSingle();
  const row = ord as { company_id: string; order_type: string } | null;
  if (!row || row.order_type !== 'dine_in') {
    return jsonWithCors({ ok: false, error: 'Cuenta no encontrada' }, 404);
  }

  try {
    const tab = await addTabItems(sb, row.company_id, orderId, parsed.items);
    return jsonWithCors({ ok: true, tab }, 201);
  } catch (err) {
    if (err instanceof DineInError) return jsonWithCors({ ok: false, error: err.message }, err.status);
    console.error('[checkout tab items] error', err);
    return jsonWithCors({ ok: false, error: 'No se pudieron agregar los ítems' }, 500);
  }
}

export async function OPTIONS() {
  return preflight();
}

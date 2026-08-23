import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { jsonWithCors, preflight } from '@/lib/checkout/cors';
import { getTab, DineInError } from '@/lib/dinein-tabs';
import { getSplitView } from '@/lib/dinein-split';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/checkout/tab/:orderId   (público — la tienda /mesa/cuenta)
 *
 * Devuelve la cuenta de mesa (ítems + total) y el estado del split
 * (recaudado / falta / porciones). Se accede por el orderId (token no adivinable).
 */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await ctx.params;
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
    const tab = await getTab(sb, row.company_id, orderId);
    const split = await getSplitView(sb, row.company_id, orderId);
    return jsonWithCors({ ok: true, tab, split });
  } catch (err) {
    if (err instanceof DineInError) return jsonWithCors({ ok: false, error: err.message }, err.status);
    console.error('[checkout tab GET] error', err);
    return jsonWithCors({ ok: false, error: 'Error en la cuenta' }, 500);
  }
}

export async function OPTIONS() {
  return preflight();
}

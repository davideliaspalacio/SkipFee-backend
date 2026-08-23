import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { jsonWithCors, preflight } from '@/lib/checkout/cors';
import { sendTabToKitchen, DineInError } from '@/lib/dinein-tabs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/checkout/tab/:orderId/send-kitchen   (público — autoservicio por QR)
 *
 * El comensal confirma su ronda → los ítems pendientes pasan a cocina.
 */
export async function POST(_request: NextRequest, ctx: { params: Promise<{ orderId: string }> }) {
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
    const tab = await sendTabToKitchen(sb, row.company_id, orderId);
    return jsonWithCors({ ok: true, tab });
  } catch (err) {
    if (err instanceof DineInError) return jsonWithCors({ ok: false, error: err.message }, err.status);
    console.error('[checkout tab send-kitchen] error', err);
    return jsonWithCors({ ok: false, error: 'No se pudo enviar a cocina' }, 500);
  }
}

export async function OPTIONS() {
  return preflight();
}

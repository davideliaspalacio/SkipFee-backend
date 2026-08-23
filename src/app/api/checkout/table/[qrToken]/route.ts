import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { jsonWithCors, preflight } from '@/lib/checkout/cors';
import { openTab, DineInError } from '@/lib/dinein-tabs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/checkout/table/:qrToken   (público — el comensal escanea el QR)
 *
 * Resuelve la mesa por su `qr_token`, abre (o recupera) su cuenta y la devuelve.
 * A partir de acá la tienda /mesa agrega ítems con el orderId de la cuenta.
 */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ qrToken: string }> }) {
  const { qrToken } = await ctx.params;
  const sb = supabaseAdmin();

  const { data: table } = await sb
    .from('dining_tables')
    .select('id, company_id, code, label, archived, is_active')
    .eq('qr_token', qrToken)
    .maybeSingle();
  const t = table as
    | { id: string; company_id: string; code: string; label: string | null; archived: boolean; is_active: boolean }
    | null;
  if (!t || t.archived || !t.is_active) {
    return jsonWithCors({ ok: false, error: 'Mesa no disponible' }, 404);
  }

  try {
    const tab = await openTab(sb, t.company_id, t.id);
    const { data: prods } = await sb
      .from('products')
      .select('id, name, price, cat, img, description')
      .eq('company_id', t.company_id)
      .eq('available', true)
      .eq('archived', false)
      .order('cat');
    return jsonWithCors({ ok: true, table: { code: t.code, label: t.label }, tab, catalog: prods ?? [] });
  } catch (err) {
    if (err instanceof DineInError) return jsonWithCors({ ok: false, error: err.message }, err.status);
    console.error('[checkout table GET] error', err);
    return jsonWithCors({ ok: false, error: 'No se pudo abrir la cuenta' }, 500);
  }
}

export async function OPTIONS() {
  return preflight();
}

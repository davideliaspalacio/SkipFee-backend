import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { jsonWithCors, preflight } from '@/lib/checkout/cors';
import { generateIntegritySignature } from '@/lib/wompi/signature';
import { wompiConfigFor } from '@/lib/integrations';
import { createWompiShare } from '@/lib/dinein-split';
import { DineInError } from '@/lib/dinein-tabs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/checkout/tab/:orderId/pay-share   (público — cada comensal paga su parte)
 *
 * Crea una porción (order_payments 'procesando') por `amount` (COP, entero, no
 * mayor a lo que falta) y devuelve un widgetConfig Wompi firmado con reference
 * propio (sp_*). El webhook liquida la porción y cierra la cuenta al completarse.
 */
const bodySchema = z.object({
  amount: z.number().int().positive(),
  label: z.string().max(60).optional(),
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
  const companyId = row.company_id;

  let share: { shareId: string; reference: string; amount: number };
  try {
    share = await createWompiShare(sb, companyId, orderId, parsed.amount, parsed.label ?? null);
  } catch (err) {
    if (err instanceof DineInError) return jsonWithCors({ ok: false, error: err.message }, err.status);
    console.error('[pay-share] error', err);
    return jsonWithCors({ ok: false, error: 'No se pudo iniciar el pago' }, 500);
  }

  const wompi = await wompiConfigFor(companyId);
  const amountInCents = share.amount * 100;
  const storefrontOrigin = process.env.STOREFRONT_ORIGIN ?? 'http://localhost:5173';
  const redirectUrl = `${storefrontOrigin}/mesa/cuenta?orderId=${orderId}`;

  if (wompi.mode === 'real') {
    if (!wompi.publicKey) {
      return jsonWithCors({ ok: false, error: 'wompi_public_key no configurado para la empresa' }, 500);
    }
    let signature: string;
    try {
      signature = generateIntegritySignature({
        reference: share.reference,
        amountInCents,
        currency: 'COP',
        integritySecret: wompi.integritySecret,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'integrity signature error';
      return jsonWithCors({ ok: false, error: msg }, 500);
    }
    const widgetConfig = {
      publicKey: wompi.publicKey,
      currency: 'COP' as const,
      amountInCents,
      reference: share.reference,
      signature,
      redirectUrl,
      customerData: { fullName: parsed.label ?? 'Cuenta de mesa' },
    };
    return jsonWithCors({ ok: true, shareId: share.shareId, amount: share.amount, paymentLink: null, widgetConfig });
  }

  // Mock: página local que simula el pago (posteará el reference-porción al webhook).
  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'http://localhost:3000';
  const paymentLink = `${origin}/wompi/checkout/${share.reference}`;
  return jsonWithCors({ ok: true, shareId: share.shareId, amount: share.amount, paymentLink, widgetConfig: null });
}

export async function OPTIONS() {
  return preflight();
}

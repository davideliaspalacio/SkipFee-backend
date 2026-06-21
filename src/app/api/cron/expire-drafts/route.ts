import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/cron/expire-drafts
 *
 * Lo invoca pg_cron de Supabase (ver supabase/migrations/0009_expire_drafts_cron.sql).
 * Marca como `expirado` los carritos `borrador` cuyo `expires_at` ya pasó. Esos
 * borradores son los pre-creados por POST /api/checkout/sessions que el cliente
 * nunca terminó de pagar.
 *
 * Auth: header `x-cron-secret` debe coincidir con `CRON_SECRET` (mismo patrón que
 * /api/cron/inactivity-check). Sin `CRON_SECRET` configurado → 503 (no exponemos
 * un endpoint público que muta estados).
 *
 * Idempotente: solo toca filas que siguen en `borrador` y vencidas, así que
 * correrlo de más no rompe nada.
 *
 * Multi-empresa: pg_cron sigue llamando un endpoint global; aquí iteramos por
 * empresa activa y scopeamos el UPDATE por `company_id`. Así cada empresa expira
 * solo sus propios borradores (red de seguridad por si en el futuro hay reglas
 * de expiración por empresa).
 *
 * Opcional (futuro): además del UPDATE, mandar un WhatsApp "tu carrito venció 🛒,
 * escribime *pedir* para reabrirlo" al phone de cada borrador expirado. Se deja
 * fuera por ahora para no spamear; el `data` devuelto trae los phones si se quiere
 * activar.
 */
export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return Response.json({ ok: false, error: 'CRON_SECRET no configurado' }, { status: 503 });
  }
  if (secret !== expected) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const sb = supabaseAdmin();
  const nowIso = new Date().toISOString();

  const { data: companies, error: companiesErr } = await sb
    .from('companies')
    .select('id')
    .eq('status', 'active');

  if (companiesErr) {
    console.error('[cron/expire-drafts] companies error', companiesErr);
    return Response.json({ ok: false, error: companiesErr.message }, { status: 500 });
  }

  let expired = 0;
  for (const company of companies ?? []) {
    const companyId = company.id as string;
    const { data, error } = await sb
      .from('orders')
      .update({ status: 'expirado' })
      .eq('company_id', companyId)
      .eq('status', 'borrador')
      .lt('expires_at', nowIso)
      .select('id, phone');

    if (error) {
      console.error('[cron/expire-drafts] update error', { companyId, error });
      continue; // un fallo de una empresa no debe frenar al resto
    }
    expired += data?.length ?? 0;
  }

  if (expired > 0) {
    console.log('[cron/expire-drafts] borradores expirados', { expired, at: nowIso });
  }

  return Response.json({ ok: true, checkedAt: nowIso, expired });
}

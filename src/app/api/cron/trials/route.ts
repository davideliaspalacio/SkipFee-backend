import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { env } from '@/lib/env';
import { platformSettings } from '@/lib/trial';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Marca en `companies.onboarding_nudges` para no repetir el aviso cada día. */
const MARCA = 'trial-vencido';

interface EmpresaVencida {
  code: number;
  slug: string;
  name: string;
  trialEndsAt: string;
}

async function avisarEquipo(empresas: EmpresaVencida[]): Promise<void> {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url || empresas.length === 0) {
    console.warn('[cron/trials] pruebas vencidas:', empresas);
    return;
  }

  const embed = {
    title: '⏳ Se les acabó la prueba',
    color: 0xef4444,
    description:
      'Ya no pueden entrar a su panel (el bot y la tienda siguen funcionando). ' +
      'Llámalos hoy: el día del vencimiento es cuando todavía hay conversación.',
    fields: empresas.slice(0, 25).map(e => ({
      name: `${e.name} (${e.code})`,
      value: `Venció el ${new Date(e.trialEndsAt).toLocaleDateString('es-CO')}`,
      inline: false,
    })),
    footer: { text: 'cron/trials' },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Skipfee Trials', embeds: [embed] }),
    });
    if (!res.ok) console.error('[cron/trials] discord', res.status);
  } catch (err) {
    console.error('[cron/trials] discord error', err);
  }
}

/**
 * POST /api/cron/trials
 *
 * Vence las pruebas gratis. Lo invoca pg_cron (mismo patrón que expire-drafts e
 * inactivity-check: header `x-cron-secret`).
 *
 * **No suspende a nadie.** El bloqueo por vencimiento es del panel y lo aplica
 * `getTenantContext` comparando la fecha en cada request: el bot sigue
 * atendiendo y la tienda sigue cobrando. Suspender la empresa apagaría también
 * la venta, que es exactamente lo que el negocio decidió no hacer.
 *
 * Lo que sí hace este cron es **avisar**: reporta por Discord a quién se le
 * venció la prueba, para que alguien lo llame el mismo día. Un vencimiento
 * silencioso es un cliente perdido sin conversación.
 *
 * Deja fuera, a propósito:
 *   - `cortesia` (piloto, demos, socios) — no tiene reloj.
 *   - `activo` (pagando) — su corte, cuando exista cobro, será por cobro
 *     fallido, no por calendario.
 */
export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return Response.json({ ok: false, error: 'CRON_SECRET no configurado' }, { status: 503 });
  }
  if (request.headers.get('x-cron-secret') !== expected) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const sb = supabaseAdmin();
  const ahora = new Date().toISOString();
  const { alVencer } = await platformSettings();

  const { data: vencidas, error } = await sb
    .from('companies')
    .select('id, code, slug, name, trial_ends_at, onboarding_nudges')
    .eq('plan', 'trial')
    .eq('status', 'active')
    .not('trial_ends_at', 'is', null)
    .lt('trial_ends_at', ahora);

  if (error) {
    console.error('[cron/trials] query error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Solo las que no se han reportado: si no, el mismo negocio genera una alerta
  // cada día hasta que pague, y el canal se vuelve ruido.
  const nuevas = (vencidas ?? []).filter(
    c => !(((c.onboarding_nudges as string[] | null) ?? []).includes(MARCA)),
  );

  const empresas = nuevas.map(c => ({
    code: c.code as number,
    slug: c.slug as string,
    name: c.name as string,
    trialEndsAt: c.trial_ends_at as string,
  }));

  if (empresas.length === 0) {
    return Response.json({ ok: true, modo: alVencer, vencidas: 0, empresas: [] });
  }

  if (alVencer === 'bloquear') await avisarEquipo(empresas);
  else console.warn('[cron/trials] pruebas vencidas (modo avisar):', empresas);

  for (const c of nuevas) {
    const previos = new Set<string>(((c.onboarding_nudges as string[] | null) ?? []));
    previos.add(MARCA);
    const { error: marcaErr } = await sb
      .from('companies')
      .update({ onboarding_nudges: [...previos] })
      .eq('id', c.id as string);
    if (marcaErr) console.error('[cron/trials] no se pudo marcar', c.code, marcaErr.message);
  }

  return Response.json({ ok: true, modo: alVencer, vencidas: empresas.length, empresas });
}

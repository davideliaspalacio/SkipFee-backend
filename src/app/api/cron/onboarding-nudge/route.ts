import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { env } from '@/lib/env';
import { getCompanyIntegrations } from '@/lib/integrations';
import { evolutionSesionConectada } from '@/lib/whatsapp/evolution/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/cron/onboarding-nudge
 *
 * El carril humano del onboarding, disparado **por comportamiento y no por
 * calendario**: avisa al equipo de los negocios que se registraron y se
 * quedaron trabados, para que los llamen ellos.
 *
 *   - 48 h sin carta       → nadie va a vender sin productos.
 *   - 72 h sin WhatsApp    → o se atascó con Meta, o le dio miedo el QR.
 *
 * Por qué existe: el 89,7% de los micronegocios colombianos no tiene registro
 * en Cámara de Comercio y Wompi exige RUT, cuenta a nombre del comercio, selfie
 * y contrato. Ese muro no lo tumba ningún autoservicio; una llamada sí. El
 * autoservicio baja el costo de atender, no elimina el momento en que hace
 * falta un humano.
 *
 * Idempotente por `companies.onboarding_nudges`: cada tipo de aviso sale una
 * sola vez por empresa. Sin esa marca, un negocio atascado generaría una alerta
 * diaria hasta desatascarse — la forma más rápida de que el equipo aprenda a
 * ignorar el canal.
 */

const HORAS_SIN_CARTA = 48;
const HORAS_SIN_WHATSAPP = 72;
const HORA_MS = 3_600_000;

type Aviso = 'carta' | 'whatsapp';

interface Atascado {
  id: string;
  code: number;
  name: string;
  slug: string;
  aviso: Aviso;
  horas: number;
}

async function avisarEquipo(atascados: Atascado[]): Promise<void> {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url || atascados.length === 0) return;

  const embed = {
    title: '👋 Negocios que necesitan una mano',
    color: 0xf59e0b,
    description:
      'Se registraron y se quedaron a medio camino. Escríbeles por WhatsApp antes de que se enfríen.',
    fields: atascados.slice(0, 25).map(a => ({
      name: `${a.name} (${a.code})`,
      value:
        a.aviso === 'carta'
          ? `Lleva ${a.horas} h sin cargar la carta.`
          : `Lleva ${a.horas} h sin conectar su WhatsApp.`,
      inline: false,
    })),
    footer: { text: 'cron/onboarding-nudge' },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Skipfee Onboarding', embeds: [embed] }),
    });
    if (!res.ok) {
      console.error('[onboarding-nudge] discord', res.status, await res.text().catch(() => ''));
    }
  } catch (err) {
    console.error('[onboarding-nudge] discord error', err);
  }
}

export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return Response.json({ ok: false, error: 'CRON_SECRET no configurado' }, { status: 503 });
  }
  if (request.headers.get('x-cron-secret') !== expected) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const sb = supabaseAdmin();
  const ahora = Date.now();

  // Solo negocios jóvenes y vivos: uno de hace tres meses que nunca cargó carta
  // ya no es un onboarding trabado, es una cuenta abandonada.
  const desde = new Date(ahora - 30 * 24 * HORA_MS).toISOString();

  const { data: empresas, error } = await sb
    .from('companies')
    .select('id, code, slug, name, created_at, onboarding_nudges')
    .eq('status', 'active')
    .gte('created_at', desde);

  if (error) {
    console.error('[onboarding-nudge] query error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const atascados: Atascado[] = [];

  for (const empresa of empresas ?? []) {
    const companyId = empresa.id as string;
    const enviados = new Set<string>((empresa.onboarding_nudges as string[] | null) ?? []);
    const horas = Math.floor((ahora - new Date(empresa.created_at as string).getTime()) / HORA_MS);

    const base = {
      id: companyId,
      code: empresa.code as number,
      name: empresa.name as string,
      slug: empresa.slug as string,
      horas,
    };

    if (horas >= HORAS_SIN_CARTA && !enviados.has('carta')) {
      const { count } = await sb
        .from('products')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('archived', false);
      if ((count ?? 0) === 0) atascados.push({ ...base, aviso: 'carta' });
    }

    if (horas >= HORAS_SIN_WHATSAPP && !enviados.has('whatsapp')) {
      const integraciones = await getCompanyIntegrations(companyId).catch(() => null);
      const conectado = integraciones
        ? integraciones.whatsapp_provider === 'evolution'
          ? evolutionSesionConectada(integraciones.evolution_session_state)
          : !!(integraciones.kapso_api_key && integraciones.kapso_phone_number_id)
        : false;
      if (!conectado) atascados.push({ ...base, aviso: 'whatsapp' });
    }
  }

  if (atascados.length === 0) {
    return Response.json({ ok: true, avisados: 0, empresas: [] });
  }

  await avisarEquipo(atascados);

  // Marcar DESPUÉS de avisar: si Discord falla, el aviso vuelve a intentarse
  // mañana en vez de perderse en silencio.
  //
  // Se agrupa por empresa antes de escribir: una empresa puede disparar los dos
  // avisos en la misma corrida, y dos UPDATE sueltos calculados sobre la fila
  // original harían que el segundo pisara al primero.
  const porEmpresa = new Map<string, Set<string>>();
  for (const a of atascados) {
    if (!porEmpresa.has(a.id)) {
      const previos = ((empresas ?? []).find(e => e.id === a.id)?.onboarding_nudges as
        | string[]
        | null) ?? [];
      porEmpresa.set(a.id, new Set<string>(previos));
    }
    porEmpresa.get(a.id)!.add(a.aviso);
  }

  for (const [companyId, avisos] of porEmpresa) {
    const { error: marcaErr } = await sb
      .from('companies')
      .update({ onboarding_nudges: [...avisos] })
      .eq('id', companyId);
    if (marcaErr) console.error('[onboarding-nudge] no se pudo marcar', companyId, marcaErr.message);
  }

  return Response.json({
    ok: true,
    avisados: atascados.length,
    empresas: atascados.map(a => ({ code: a.code, name: a.name, aviso: a.aviso, horas: a.horas })),
  });
}

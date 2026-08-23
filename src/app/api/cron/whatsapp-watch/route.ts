import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { env } from '@/lib/env';
import { invalidateIntegrationsCache } from '@/lib/integrations';
import { providerFor } from '@/lib/whatsapp/factory';
import { isSessionCapable } from '@/lib/whatsapp/provider';
import { mapEvolutionState } from '@/lib/whatsapp/evolution/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/cron/whatsapp-watch
 *
 * Vigila las sesiones de Evolution de los negocios que YA estuvieron
 * operativos, y sincroniza `evolution_session_state` con lo que responde el
 * servidor en vivo.
 *
 * Por qué existe, si el webhook ya avisa: porque el webhook es lo primero que
 * se pierde. Llega por una URL pública que puede estar caída, detrás de un
 * túnel que se reinicia, o el propio servidor de Evolution puede quedarse mudo.
 * Cuando eso pasa, la columna se congela diciendo "conectado" y el panel jura
 * que todo va bien mientras el negocio lleva horas sin recibir un pedido. Ese
 * es el peor modo de falla del producto: silencioso.
 *
 * El otro camino que ya existe —el GET de la pantalla de sesión— solo corre si
 * alguien está mirando. Este cron cubre justo el caso contrario.
 *
 * NO alerta a los que nunca estuvieron conectados (`operativo_desde IS NULL`):
 * a quien todavía no ha vinculado su número no se le avisa que "se desconectó".
 */

/** Marca en `companies.onboarding_nudges` para no repetir el aviso cada vuelta. */
const MARCA = 'whatsapp-caido';

interface Caido {
  id: string;
  code: number;
  name: string;
  estado: string;
  avisado: boolean;
}

async function avisarEquipo(caidos: Caido[]): Promise<void> {
  const nuevos = caidos.filter(c => !c.avisado);
  const url = env.DISCORD_WEBHOOK_URL;
  if (nuevos.length === 0) return;
  if (!url) {
    console.warn('[cron/whatsapp-watch] WhatsApp caído:', nuevos);
    return;
  }

  const embed = {
    title: '🔌 WhatsApp caído',
    color: 0xef4444,
    description:
      'Estos negocios ya estaban operando y su sesión se desvinculó. ' +
      'No están recibiendo pedidos: hay que llamarlos para que vuelvan a escanear.',
    fields: nuevos.slice(0, 25).map(c => ({
      name: `${c.name} (${c.code})`,
      value: `Estado del canal: ${c.estado}`,
      inline: false,
    })),
    footer: { text: 'cron/whatsapp-watch' },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Skipfee Canales', embeds: [embed] }),
    });
    if (!res.ok) console.error('[cron/whatsapp-watch] discord', res.status);
  } catch (err) {
    console.error('[cron/whatsapp-watch] discord error', err);
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

  const { data: empresas, error } = await sb
    .from('companies')
    .select('id, code, name, onboarding_nudges, company_integrations(whatsapp_provider, evolution_session_state)')
    .eq('status', 'active')
    .not('operativo_desde', 'is', null);

  if (error) {
    console.error('[cron/whatsapp-watch] query error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const caidos: Caido[] = [];
  let revisadas = 0;

  for (const empresa of empresas ?? []) {
    const raw = empresa.company_integrations as
      | { whatsapp_provider?: string | null; evolution_session_state?: string | null }
      | Array<{ whatsapp_provider?: string | null; evolution_session_state?: string | null }>
      | null;
    const integraciones = (Array.isArray(raw) ? raw[0] : raw) ?? null;

    // Kapso no tiene sesión que se caiga: su número está verificado con Meta.
    if (integraciones?.whatsapp_provider !== 'evolution') continue;

    const companyId = empresa.id as string;
    const guardado = mapEvolutionState(integraciones.evolution_session_state);
    const avisos = new Set<string>((empresa.onboarding_nudges as string[] | null) ?? []);

    let vivo: string;
    try {
      const provider = await providerFor(companyId);
      if (!isSessionCapable(provider)) continue;
      const sesion = await provider.getSession();
      vivo = sesion.status;
      revisadas += 1;
    } catch (err) {
      // El servidor de Evolution inalcanzable NO es lo mismo que una sesión
      // caída: si asumiéramos "desconectado" marcaríamos a todos los negocios a
      // la vez cada vez que se reinicie el servidor. Se deja el estado como
      // está y se reintenta a la vuelta siguiente.
      console.warn('[cron/whatsapp-watch] no se pudo consultar', empresa.code, err);
      continue;
    }

    // Se escribe solo cuando cambia, para no tocar `updated_at` en cada vuelta.
    if (vivo !== 'unknown' && vivo !== guardado) {
      const { error: updErr } = await sb
        .from('company_integrations')
        .update({ evolution_session_state: vivo, evolution_session_updated_at: new Date().toISOString() })
        .eq('company_id', companyId);
      if (updErr) console.error('[cron/whatsapp-watch] update', empresa.code, updErr.message);
      else invalidateIntegrationsCache(companyId);
    }

    if (vivo === 'disconnected') {
      caidos.push({
        id: companyId,
        code: empresa.code as number,
        name: empresa.name as string,
        estado: vivo,
        avisado: avisos.has(MARCA),
      });
    } else if (avisos.has(MARCA)) {
      // Volvió: se limpia la marca para que la próxima caída sí avise.
      avisos.delete(MARCA);
      await sb
        .from('companies')
        .update({ onboarding_nudges: [...avisos] })
        .eq('id', companyId);
    }
  }

  await avisarEquipo(caidos);

  // Marcar los nuevos DESPUÉS de avisar: si Discord falla, se reintenta.
  for (const c of caidos.filter(x => !x.avisado)) {
    const previos = new Set<string>(
      ((empresas ?? []).find(e => e.id === c.id)?.onboarding_nudges as string[] | null) ?? [],
    );
    previos.add(MARCA);
    await sb.from('companies').update({ onboarding_nudges: [...previos] }).eq('id', c.id);
  }

  return Response.json({
    ok: true,
    revisadas,
    caidos: caidos.length,
    empresas: caidos.map(c => ({ code: c.code, name: c.name, nuevo: !c.avisado })),
  });
}

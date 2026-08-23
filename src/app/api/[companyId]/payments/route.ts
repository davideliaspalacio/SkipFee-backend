import { z } from 'zod';
import { withTenant } from '@/lib/tenant';
import { supabaseAdmin } from '@/lib/db';
import { getCompanyIntegrations, invalidateIntegrationsCache } from '@/lib/integrations';
import { cifrarPatch } from '@/lib/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Pasarela de pagos de una empresa.
 *
 *   GET → modo actual y qué credenciales están cargadas
 *   PUT → cambiar de modo y/o cargar las llaves de Wompi
 *
 * El entorno (pruebas o producción) NO es un campo aparte: lo decide el prefijo
 * de la llave pública, que es como lo decide Wompi. `pub_test_…` va contra su
 * sandbox y no mueve un peso; `pub_prod_…` cobra de verdad. Guardar un flag
 * aparte solo agrega una forma de que la etiqueta mienta.
 *
 * Dos modos:
 *   - `mock`  — pasarela de prueba. El pedido se marca pagado sin cobrar nada.
 *               Es el default de toda empresa nueva: permite recorrer el flujo
 *               completo (bot → carrito → pago → cocina) sin abrir cuenta en
 *               ningún banco. Wompi exige RUT, cuenta bancaria a nombre del
 *               comercio, selfie y contrato: días o semanas de trámite que no
 *               deberían bloquear la prueba del producto.
 *   - `real`   — Wompi de verdad, con las llaves del comercio.
 *
 * ⚠️ NUNCA se devuelven los secretos: el GET solo informa si están presentes.
 *    La llave pública sí se devuelve — viaja al navegador del comensal de todos
 *    modos, es pública por diseño.
 */

const bodySchema = z.object({
  mode: z.enum(['mock', 'real']).optional(),
  wompi: z
    .object({
      publicKey: z.string().min(10).optional(),
      integritySecret: z.string().min(10).optional(),
      eventsSecret: z.string().min(10).optional(),
    })
    .optional(),
});

/** Wompi distingue sandbox de producción por el prefijo de la llave pública. */
function entornoDeLlave(publicKey: string | null): 'pruebas' | 'produccion' | null {
  if (!publicKey) return null;
  return publicKey.startsWith('pub_test_') ? 'pruebas' : 'produccion';
}

function canManage(role: string): boolean {
  return role === 'super_admin' || role === 'admin' || role === 'platform';
}

export const GET = withTenant(async (_request, ctx) => {
  let row;
  try {
    row = await getCompanyIntegrations(ctx.company.id);
  } catch {
    return Response.json(
      { ok: false, error: 'La empresa no tiene fila de integraciones.' },
      { status: 409 },
    );
  }

  const mode = row.wompi_mode === 'real' ? 'real' : 'mock';
  const entorno = entornoDeLlave(row.wompi_public_key);

  return Response.json({
    ok: true,
    mode,
    /** 'pruebas' | 'produccion' | null (sin llave todavía). */
    entorno,
    wompi: {
      /** Con las tres llaves cargadas ya se puede pasar a modo real. */
      configured: !!(row.wompi_public_key && row.wompi_integrity_secret && row.wompi_events_secret),
      publicKey: row.wompi_public_key,
      hasIntegritySecret: !!row.wompi_integrity_secret,
      hasEventsSecret: !!row.wompi_events_secret,
    },
  });
});

export const PUT = withTenant(async (request, ctx) => {
  if (!canManage(ctx.role)) {
    return Response.json({ ok: false, error: 'Sin permiso' }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'Body inválido', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const patch: Record<string, string> = {};
  if (body.mode) patch.wompi_mode = body.mode;
  if (body.wompi?.publicKey) patch.wompi_public_key = body.wompi.publicKey;
  if (body.wompi?.integritySecret) patch.wompi_integrity_secret = body.wompi.integritySecret;
  if (body.wompi?.eventsSecret) patch.wompi_events_secret = body.wompi.eventsSecret;

  if (Object.keys(patch).length === 0) {
    return Response.json({ ok: false, error: 'Nada que actualizar' }, { status: 400 });
  }

  // Validar ANTES de escribir: pasar a `real` sin llaves deja al negocio
  // cobrando con una pasarela que no existe, y el fallo aparece recién cuando
  // un cliente intenta pagar — o sea, en la peor ocasión posible.
  if (body.mode === 'real') {
    const current = await getCompanyIntegrations(ctx.company.id).catch(() => null);
    const merged = { ...current, ...patch } as Record<string, unknown>;
    const faltan = [
      !merged.wompi_public_key && 'llave pública',
      !merged.wompi_integrity_secret && 'secreto de integridad',
      !merged.wompi_events_secret && 'secreto de eventos',
    ].filter(Boolean);

    if (faltan.length > 0) {
      return Response.json(
        {
          ok: false,
          error: `Para cobrar de verdad faltan: ${faltan.join(', ')}. ` +
            'Están en tu panel de Wompi, en Desarrolladores → Llaves.',
        },
        { status: 400 },
      );
    }
  }

  const { error } = await supabaseAdmin()
    .from('company_integrations')
    .update(cifrarPatch(patch))
    .eq('company_id', ctx.company.id);

  if (error) {
    console.error('[payments PUT] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  invalidateIntegrationsCache(ctx.company.id);

  return Response.json({
    ok: true,
    mode: body.mode ?? undefined,
    entorno: entornoDeLlave(body.wompi?.publicKey ?? null),
  });
});

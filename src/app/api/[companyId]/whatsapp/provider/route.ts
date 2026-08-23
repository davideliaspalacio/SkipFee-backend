import { z } from 'zod';
import { withTenant } from '@/lib/tenant';
import { supabaseAdmin } from '@/lib/db';
import { getCompanyIntegrations, invalidateIntegrationsCache } from '@/lib/integrations';
import { cifrarPatch } from '@/lib/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Selector de proveedor de WhatsApp de una empresa.
 *
 *   GET → proveedor activo + qué credenciales están cargadas
 *   PUT → cambiar de proveedor y/o actualizar credenciales
 *
 * Pensado para la EMPRESA DE PRUEBAS: permite correr el mismo flujo del bot por
 * Kapso o por Evolution y comparar el comportamiento (sobre todo la degradación
 * de botones) sin tocar un negocio real.
 *
 * ⚠️ NUNCA se devuelven los secretos. El GET solo informa si están presentes;
 *    `company_integrations` es una tabla sensible y este endpoint lo respeta.
 */

const bodySchema = z.object({
  provider: z.enum(['kapso', 'evolution']).optional(),
  kapso: z
    .object({
      phoneNumberId: z.string().min(1).optional(),
      apiKey: z.string().min(1).optional(),
      webhookSecret: z.string().min(1).optional(),
    })
    .optional(),
  evolution: z
    .object({
      baseUrl: z.string().url().optional(),
      apiKey: z.string().min(1).optional(),
      instance: z
        .string()
        .min(1)
        // El nombre de instancia viaja en la URL de Evolution; restringirlo
        // evita sorpresas de encoding y colisiones raras.
        .regex(/^[a-zA-Z0-9._-]+$/, 'Solo letras, números, punto, guion y guion bajo')
        .optional(),
      webhookToken: z.string().min(8).optional(),
    })
    .optional(),
});

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

  return Response.json({
    ok: true,
    provider: row.whatsapp_provider,
    kapso: {
      configured: !!(row.kapso_api_key && row.kapso_phone_number_id),
      phoneNumberId: row.kapso_phone_number_id,
      hasWebhookSecret: !!row.kapso_webhook_secret,
    },
    evolution: {
      // "Configurado" = hay un servidor Evolution utilizable, sea el COMPARTIDO
      // de Skipfee (lo normal) o un override propio de la empresa. El negocio
      // no aporta infraestructura: si hay servidor, ya puede escanear el QR.
      configured: !!(
        (row.evolution_base_url ?? process.env.EVOLUTION_BASE_URL) &&
        (row.evolution_api_key ?? process.env.EVOLUTION_API_KEY)
      ),
      /** true = corre en el servidor compartido de Skipfee (sin datos propios). */
      managed: !row.evolution_base_url,
      baseUrl: row.evolution_base_url,
      instance: row.evolution_instance,
      hasWebhookToken: !!row.evolution_webhook_token,
      sessionState: row.evolution_session_state ?? null,
      sessionUpdatedAt: row.evolution_session_updated_at ?? null,
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
  if (body.provider) patch.whatsapp_provider = body.provider;
  if (body.kapso?.phoneNumberId) patch.kapso_phone_number_id = body.kapso.phoneNumberId;
  if (body.kapso?.apiKey) patch.kapso_api_key = body.kapso.apiKey;
  if (body.kapso?.webhookSecret) patch.kapso_webhook_secret = body.kapso.webhookSecret;
  if (body.evolution?.baseUrl) patch.evolution_base_url = body.evolution.baseUrl;
  if (body.evolution?.apiKey) patch.evolution_api_key = body.evolution.apiKey;
  if (body.evolution?.instance) patch.evolution_instance = body.evolution.instance;
  if (body.evolution?.webhookToken) {
    patch.evolution_webhook_token = body.evolution.webhookToken;
  }

  if (Object.keys(patch).length === 0) {
    return Response.json({ ok: false, error: 'Nada que actualizar' }, { status: 400 });
  }

  // Validar ANTES de escribir: cambiar a un proveedor sin credenciales dejaría
  // a la empresa muda, y el fallo aparecería recién en el próximo mensaje.
  if (body.provider) {
    const current = await getCompanyIntegrations(ctx.company.id).catch(() => null);
    const merged = { ...current, ...patch } as Record<string, unknown>;

    if (body.provider === 'evolution') {
      // Las mismas reglas que `evolutionCredentialsFor`, no unas más estrictas:
      // el servidor Evolution es COMPARTIDO (env) y la fila de la empresa solo
      // sirve como override. El nombre de instancia ni siquiera se pide — se
      // deriva del slug al conectar.
      //
      // Antes esto exigía las tres columnas en la fila y hacía imposible
      // conectar por QR desde el panel: el GET decía "configurado" (porque mira
      // el env) y el PUT lo negaba. Nadie aporta infraestructura para escanear
      // un código.
      const baseUrl = merged.evolution_base_url ?? process.env.EVOLUTION_BASE_URL;
      const apiKey = merged.evolution_api_key ?? process.env.EVOLUTION_API_KEY;

      if (!baseUrl || !apiKey) {
        return Response.json(
          {
            ok: false,
            error:
              'No hay servidor de Evolution configurado. Falta ' +
              [!baseUrl && 'EVOLUTION_BASE_URL', !apiKey && 'EVOLUTION_API_KEY']
                .filter(Boolean)
                .join(' y ') +
              ' en el backend (o las credenciales propias de esta empresa).',
          },
          { status: 503 },
        );
      }
    }

    if (body.provider === 'kapso') {
      const missing = [
        !merged.kapso_api_key && 'kapso_api_key',
        !merged.kapso_phone_number_id && 'kapso_phone_number_id',
      ].filter(Boolean);
      if (missing.length > 0) {
        return Response.json(
          {
            ok: false,
            error: `Faltan credenciales de Kapso: ${missing.join(', ')}.`,
          },
          { status: 400 },
        );
      }
    }
  }

  const { error } = await supabaseAdmin()
    .from('company_integrations')
    .update(cifrarPatch(patch))
    .eq('company_id', ctx.company.id);

  if (error) {
    console.error('[whatsapp provider PUT] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Sin esto el cambio tardaría hasta 30s en verse (TTL de la cache).
  invalidateIntegrationsCache(ctx.company.id);

  return Response.json({ ok: true, provider: body.provider ?? undefined });
});

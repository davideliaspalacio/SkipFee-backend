import { randomBytes } from 'node:crypto';
import { withTenant } from '@/lib/tenant';
import { cifrarPatch } from '@/lib/crypto';
import { MissingIntegrationError, invalidateIntegrationsCache } from '@/lib/integrations';
import { isSessionCapable, providerFor } from '@/lib/whatsapp';
import { supabaseAdmin } from '@/lib/db';
import {
  evolutionCredentialsFor,
  getCompanyIntegrations,
  instanceNameFor,
} from '@/lib/integrations';
import { EvolutionProvider } from '@/lib/whatsapp/evolution/adapter';
import { mapEvolutionState } from '@/lib/whatsapp/evolution/parse';
import type { SessionStatus } from '@/lib/whatsapp/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sesión de WhatsApp de la empresa — SOLO para proveedores que la tengan.
 *
 * Kapso (Cloud API oficial) no tiene sesión: el número está verificado con Meta
 * y no se "desconecta". Evolution sí: vive de un WhatsApp Web emparejado por QR
 * que puede caerse, y entonces alguien tiene que volver a escanear.
 *
 *   GET    → estado actual (+ QR si Evolution lo está pidiendo)
 *   POST   → crear/conectar la instancia y obtener el QR
 *   DELETE → desconectar
 *
 * Para empresas en Kapso los tres responden 409: no es un error del cliente,
 * es que la pregunta no aplica a ese proveedor.
 */

const NOT_APPLICABLE = {
  ok: false as const,
  error: 'El proveedor de esta empresa no maneja sesión (Kapso no la necesita).',
};

/**
 * Guarda en la empresa el estado que acaba de reportar el proveedor.
 *
 * `evolution_session_state` es lo que lee el checklist de Primeros pasos, y
 * hasta ahora solo lo escribía el webhook `connection.update`. Ese webhook
 * puede no llegar nunca —túnel caído, webhook sin registrar, Evolution
 * reiniciado— y entonces la columna se queda congelada en el último estado
 * bueno: el panel muestra "WhatsApp listo" con el número desvinculado desde
 * ayer. Aquí ya tenemos la respuesta en vivo del proveedor, que es la fuente de
 * verdad, así que la persistimos y el checklist deja de mentir.
 */
async function sincronizarEstado(companyId: string, status: SessionStatus): Promise<void> {
  // `unknown` = no entendimos la respuesta, NO "se cayó". Degradar el checklist
  // por un shape inesperado de Evolution sería peor que conservar lo último
  // que sí supimos.
  if (status === 'unknown') return;

  let guardado: string | null;
  try {
    guardado = (await getCompanyIntegrations(companyId)).evolution_session_state;
  } catch {
    return;
  }
  // El panel sondea esto cada 3 s mientras se vincula: solo se escribe cuando
  // el estado cambió de verdad.
  if (mapEvolutionState(guardado) === status) return;

  const { error } = await supabaseAdmin()
    .from('company_integrations')
    .update({
      evolution_session_state: status,
      evolution_session_updated_at: new Date().toISOString(),
    })
    .eq('company_id', companyId);
  if (error) {
    console.error('[whatsapp session] no se pudo guardar el estado', error);
    return;
  }
  invalidateIntegrationsCache(companyId);
}

/** Solo quien administra la empresa toca la conexión de WhatsApp. */
function canManage(role: string): boolean {
  return role === 'super_admin' || role === 'admin' || role === 'platform';
}

export const GET = withTenant(async (_request, ctx) => {
  let provider;
  try {
    provider = await providerFor(ctx.company.id);
  } catch (err) {
    if (err instanceof MissingIntegrationError) {
      return Response.json({ ok: false, error: err.message }, { status: 409 });
    }
    throw err;
  }

  if (!isSessionCapable(provider)) {
    return Response.json({ ...NOT_APPLICABLE, provider: provider.kind }, { status: 409 });
  }

  try {
    const session = await provider.getSession();
    await sincronizarEstado(ctx.company.id, session.status);

    // Señal de que el canal REALMENTE funciona: no basta con que la sesión diga
    // "conectada", tiene que estar entrando tráfico. Si el webhook no quedó
    // registrado, la sesión se ve verde y esto se queda en null para siempre.
    const { data: lastIn } = await supabaseAdmin()
      .from('messages')
      .select('created_at')
      .eq('company_id', ctx.company.id)
      .eq('direction', 'in')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return Response.json({
      ok: true,
      provider: provider.kind,
      session,
      lastInboundAt: lastIn?.created_at ?? null,
    });
  } catch (err) {
    // Evolution caído o inalcanzable: es información útil, no un 500 opaco.
    console.error('[whatsapp session GET] error', err);
    return Response.json(
      {
        ok: false,
        provider: provider.kind,
        error: 'No se pudo consultar el servidor de Evolution.',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
});

export const POST = withTenant(async (_request, ctx) => {
  if (!canManage(ctx.role)) {
    return Response.json({ ok: false, error: 'Sin permiso' }, { status: 403 });
  }

  let provider;
  try {
    provider = await providerFor(ctx.company.id);
  } catch (err) {
    if (err instanceof MissingIntegrationError) {
      return Response.json({ ok: false, error: err.message }, { status: 409 });
    }
    throw err;
  }

  if (!isSessionCapable(provider)) {
    return Response.json({ ...NOT_APPLICABLE, provider: provider.kind }, { status: 409 });
  }

  try {
    // 1. Asegurar el token del webhook ANTES de conectar.
    //
    // Sin token, `verifyWebhook` rechaza todo lo entrante con 401: la sesión se
    // vería "conectada" y no entraría un solo pedido. Lo generamos nosotros para
    // que el operario no tenga que inventarse un secreto.
    const row = await getCompanyIntegrations(ctx.company.id);

    // Fijar la instancia y el token del webhook la PRIMERA vez.
    //
    // El servidor Evolution es compartido (de Skipfee), así que el negocio no
    // aporta nada: derivamos su instancia del slug y generamos el secreto del
    // webhook nosotros. Sin token, `verifyWebhook` rechazaría todo lo entrante
    // con 401: la sesión se vería conectada y no entraría un solo pedido.
    const patch: Record<string, string> = {};
    const instance =
      row.evolution_instance ?? instanceNameFor(row.company_slug, ctx.company.id);
    if (!row.evolution_instance) patch.evolution_instance = instance;

    const webhookToken =
      row.evolution_webhook_token ?? randomBytes(24).toString('base64url');
    if (!row.evolution_webhook_token) patch.evolution_webhook_token = webhookToken;

    if (Object.keys(patch).length > 0) {
      const { error } = await supabaseAdmin()
        .from('company_integrations')
        .update(cifrarPatch(patch))
        .eq('company_id', ctx.company.id);
      if (error) throw error;
      invalidateIntegrationsCache(ctx.company.id);
      // Reconstruir el proveedor con los valores recién fijados.
      const creds = await evolutionCredentialsFor(ctx.company.id);
      provider = new EvolutionProvider({ companyId: ctx.company.id, ...creds });
    }

    // 2. Conectar la instancia y obtener el QR.
    const session = await provider.connectSession();

    // 3. Registrar el webhook. ESTE es el paso que hace que entren pedidos.
    //    Si falla, lo decimos explícitamente en vez de dejar que el operario
    //    escanee el QR y se quede esperando mensajes que nunca llegan.
    // OJO: tiene que ser la URL pública de ESTE backend, no la del panel.
    // `NEXT_PUBLIC_APP_ORIGIN` apunta al admin (sitio estático en Cloudflare):
    // registrar ahí el webhook haría que Evolution entregue los mensajes a un
    // sitio que no los procesa, y no entraría ni un pedido.
    const origin =
      process.env.BACKEND_PUBLIC_URL ??
      process.env.NEXT_PUBLIC_APP_ORIGIN ??
      'http://localhost:3000';
    const webhookUrl = `${origin.replace(/\/+$/, '')}/api/webhooks/evolution/${ctx.company.slug}`;
    let webhookOk = true;
    let webhookError: string | null = null;
    try {
      await (provider as EvolutionProvider).registerWebhook(webhookUrl);
    } catch (err) {
      webhookOk = false;
      webhookError = err instanceof Error ? err.message : String(err);
      console.error('[whatsapp session POST] no se pudo registrar el webhook', err);
    }

    await supabaseAdmin()
      .from('company_integrations')
      .update({
        evolution_session_state: session.status,
        evolution_session_updated_at: new Date().toISOString(),
      })
      .eq('company_id', ctx.company.id);
    invalidateIntegrationsCache(ctx.company.id);

    return Response.json({
      ok: true,
      provider: provider.kind,
      session,
      webhook: { url: webhookUrl, registered: webhookOk, error: webhookError },
    });
  } catch (err) {
    console.error('[whatsapp session POST] error', err);
    return Response.json(
      {
        ok: false,
        error: 'No se pudo conectar la instancia de Evolution.',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
});

export const DELETE = withTenant(async (_request, ctx) => {
  if (!canManage(ctx.role)) {
    return Response.json({ ok: false, error: 'Sin permiso' }, { status: 403 });
  }

  let provider;
  try {
    provider = await providerFor(ctx.company.id);
  } catch (err) {
    if (err instanceof MissingIntegrationError) {
      return Response.json({ ok: false, error: err.message }, { status: 409 });
    }
    throw err;
  }

  if (!isSessionCapable(provider)) {
    return Response.json({ ...NOT_APPLICABLE, provider: provider.kind }, { status: 409 });
  }

  try {
    await provider.logoutSession();
    await supabaseAdmin()
      .from('company_integrations')
      .update({
        evolution_session_state: 'disconnected',
        evolution_session_updated_at: new Date().toISOString(),
      })
      .eq('company_id', ctx.company.id);
    invalidateIntegrationsCache(ctx.company.id);

    return Response.json({ ok: true });
  } catch (err) {
    console.error('[whatsapp session DELETE] error', err);
    return Response.json(
      { ok: false, error: 'No se pudo desconectar.', detail: String(err) },
      { status: 502 },
    );
  }
});

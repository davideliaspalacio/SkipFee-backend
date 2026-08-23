import { z } from 'zod';
import { withTenant } from '@/lib/tenant';
import { MissingIntegrationError } from '@/lib/integrations';
import { recordMessage } from '@/lib/messaging';
import { botSendTextMsg } from '@/lib/bot/sender';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// E.164 sin "+", solo dígitos. Ej: "573126451209" para +57 312 645 1209.
const bodySchema = z.object({
  to: z.string().regex(/^\d{8,15}$/, 'to debe ser un número E.164 sin "+", ej: 573126451209'),
  body: z.string().min(1).max(4096),
});

/**
 * POST /api/<companyId>/messages/send
 *
 * Envío manual de un WhatsApp desde el panel (ej. operador escribiendo a un
 * cliente). Multi-empresa: va bajo `[companyId]` con `withTenant` (la membresía
 * del usuario en la empresa la valida el wrapper). Envía con el Kapso de la
 * empresa (`botSendTextMsg` → Kapso o Evolution) y persiste con
 * `recordMessage({ …, companyId })` para que el chat/mensaje queden scopeados.
 *
 * Reemplaza la antigua `/api/messages/send` (global, single-tenant), que se
 * eliminó para no dejar una ruta sin tenant ni Kapso por empresa.
 */
export const POST = withTenant(async (request, ctx) => {
  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  // 1. Enviar por el proveedor de WhatsApp de la empresa (Kapso o Evolution).
  let result;
  try {
    result = await botSendTextMsg(ctx.company.id, parsed.to, parsed.body);
  } catch (err) {
    if (err instanceof MissingIntegrationError) {
      return Response.json({ ok: false, error: err.message }, { status: 503 });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[messages/send] error de envío', err);
    return Response.json({ ok: false, error: message }, { status: 502 });
  }

  // 2. Persistir el mensaje saliente. Si falla, no rechazamos el envío
  // (Kapso ya lo mandó), pero lo logueamos para auditar.
  const wamid = result.messages?.[0]?.id ?? null;
  try {
    await recordMessage({
      phone: parsed.to,
      direction: 'out',
      body: parsed.body,
      kapsoMessageId: wamid,
      companyId: ctx.company.id,
    });
  } catch (err) {
    console.error('[messages/send] persistence error (mensaje sí se envió)', err);
  }

  return Response.json({ ok: true, result });
});

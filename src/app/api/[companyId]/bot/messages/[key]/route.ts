import { z } from 'zod';
import { MESSAGE_DEFS, type MessageContent } from '@/lib/bot/messages/defaults';
import { invalidateCatalog } from '@/lib/bot/messages/catalog';
import { validateContent } from '@/lib/bot/messages/validate';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  content: z.unknown().optional(),
  enabled: z.boolean().optional(),
});

/**
 * PATCH /api/<companyId>/bot/messages/:key — guarda la personalización de un
 * mensaje para LA empresa. Valida el `content` según el `kind` del mensaje
 * (límites de WhatsApp, ids de botón inmutables). `enabled` solo (sin content)
 * sirve para apagar/encender recordatorios opcionales. Guarda un override en
 * `bot_messages` (PK `(company_id, key)`) e invalida la cache del catálogo.
 *
 * TODO(multi-empresa, transversal): `invalidateCatalog`/`getMessage` usan una
 * cache GLOBAL (sin empresa). Falta scopear el catálogo por empresa — helper
 * compartido con el bot, lo migra otro agente.
 */
export const PATCH = withTenant<{ companyId: string; key: string }>(async (request, ctx, params) => {
  const { key } = params;
  const def = MESSAGE_DEFS[key];
  if (!def) return Response.json({ ok: false, error: 'Mensaje no encontrado' }, { status: 404 });

  let body;
  try {
    body = patchSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  if (body.content === undefined && body.enabled === undefined) {
    return Response.json({ ok: false, error: 'Nada que actualizar' }, { status: 400 });
  }

  let newContent: MessageContent | undefined;
  let warnings: string[] | undefined;
  if (body.content !== undefined) {
    const v = validateContent(def, body.content);
    if (!v.ok) return Response.json({ ok: false, errors: v.errors }, { status: 400 });
    newContent = v.content;
    warnings = v.warnings;
  }

  const sb = ctx.db;
  const companyId = ctx.company.id;

  // Para un toggle de `enabled` sin content, preservamos el content existente
  // (o el default si aún no hay override) — la columna content es NOT NULL.
  const { data: existing } = await sb
    .from('bot_messages')
    .select('content, enabled')
    .eq('company_id', companyId)
    .eq('key', key)
    .maybeSingle();

  const content = newContent ?? (existing?.content as MessageContent | undefined) ?? def.default;
  const enabled = body.enabled ?? (existing?.enabled as boolean | undefined) ?? true;

  const { error } = await sb.from('bot_messages').upsert(
    { company_id: companyId, key, content, enabled, updated_at: new Date().toISOString() },
    { onConflict: 'company_id,key' },
  );
  if (error) {
    console.error('[bot messages PATCH] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  invalidateCatalog();
  return Response.json({ ok: true, warnings });
});

/**
 * DELETE /api/<companyId>/bot/messages/:key — restaura el mensaje a su default:
 * borra el override de `bot_messages` de LA empresa. El catálogo vuelve a
 * resolver desde el código.
 */
export const DELETE = withTenant<{ companyId: string; key: string }>(async (_request, ctx, params) => {
  const { key } = params;
  const def = MESSAGE_DEFS[key];
  if (!def) return Response.json({ ok: false, error: 'Mensaje no encontrado' }, { status: 404 });

  const { error } = await ctx.db
    .from('bot_messages')
    .delete()
    .eq('company_id', ctx.company.id)
    .eq('key', key);
  if (error) {
    console.error('[bot messages DELETE] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  invalidateCatalog();
  return Response.json({ ok: true });
});

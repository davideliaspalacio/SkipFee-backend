import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { MESSAGE_DEFS, type MessageContent } from '@/lib/bot/messages/defaults';
import { invalidateCatalog } from '@/lib/bot/messages/catalog';
import { validateContent } from '@/lib/bot/messages/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  content: z.unknown().optional(),
  enabled: z.boolean().optional(),
});

/**
 * PATCH /api/bot/messages/:key — guarda la personalización de un mensaje.
 * Valida el `content` según el `kind` del mensaje (límites de WhatsApp, ids de
 * botón inmutables). `enabled` solo (sin content) sirve para apagar/encender
 * recordatorios opcionales. Guarda un override en `bot_messages` e invalida la
 * cache del catálogo para que el cambio aplique de inmediato.
 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
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

  const sb = supabaseAdmin();

  // Para un toggle de `enabled` sin content, preservamos el content existente
  // (o el default si aún no hay override) — la columna content es NOT NULL.
  const { data: existing } = await sb
    .from('bot_messages')
    .select('content, enabled')
    .eq('key', key)
    .maybeSingle();

  const content = newContent ?? (existing?.content as MessageContent | undefined) ?? def.default;
  const enabled = body.enabled ?? (existing?.enabled as boolean | undefined) ?? true;

  const { error } = await sb.from('bot_messages').upsert(
    { key, content, enabled, updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  if (error) {
    console.error('[bot messages PATCH] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  invalidateCatalog();
  return Response.json({ ok: true, warnings });
}

/**
 * DELETE /api/bot/messages/:key — restaura el mensaje a su default: borra el
 * override de `bot_messages`. El catálogo vuelve a resolver desde el código.
 */
export async function DELETE(_request: NextRequest, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  const def = MESSAGE_DEFS[key];
  if (!def) return Response.json({ ok: false, error: 'Mensaje no encontrado' }, { status: 404 });

  const { error } = await supabaseAdmin().from('bot_messages').delete().eq('key', key);
  if (error) {
    console.error('[bot messages DELETE] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  invalidateCatalog();
  return Response.json({ ok: true });
}

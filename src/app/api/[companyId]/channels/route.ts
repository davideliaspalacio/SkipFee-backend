import { z } from 'zod';
import { listChannelsOverview, setChannelAction, type ChannelProvider } from '@/lib/channels';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const actionSchema = z.object({
  provider: z.enum(['whatsapp', 'storefront', 'rappi', 'didi', 'ubereats', 'manual']),
  action: z.enum(['enable_simulator', 'prepare_live', 'pause', 'resume']),
});

/**
 * GET /api/<companyId>/channels
 * Configuración y métricas de canales para LA empresa activa.
 */
export const GET = withTenant(async (_request, ctx) => {
  try {
    const overview = await listChannelsOverview(ctx.db, ctx.company.id);
    return Response.json({ ok: true, ...overview });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'channels error';
    console.error('[channels GET] error', err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});

/**
 * PATCH /api/<companyId>/channels
 * Acciones operativas del canal. En P0 se usa para activar/pausar simuladores.
 */
export const PATCH = withTenant(async (request, ctx) => {
  let parsed: z.infer<typeof actionSchema>;
  try {
    parsed = actionSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const channel = await setChannelAction(
      ctx.db,
      ctx.company.id,
      parsed.provider as ChannelProvider,
      parsed.action,
    );
    const overview = await listChannelsOverview(ctx.db, ctx.company.id);
    return Response.json({ ok: true, channel, ...overview });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'channel update error';
    console.error('[channels PATCH] error', err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});

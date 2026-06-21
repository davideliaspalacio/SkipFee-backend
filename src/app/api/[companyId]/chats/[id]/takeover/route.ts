import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/<companyId>/chats/:id/takeover
 * Pone el chat (de LA empresa) en status='human'. El bot Kapso debe respetar
 * este flag y dejar de responder automáticamente (la lógica de skip vive en el
 * Workflow Kapso).
 *
 * Idempotente: si ya está en 'human', devuelve 200 sin cambio.
 */
export const POST = withTenant<{ companyId: string; id: string }>(async (_request, ctx, params) => {
  const { id } = params;

  const { data, error } = await ctx.db
    .from('chats')
    .update({ status: 'human' })
    .eq('company_id', ctx.company.id)
    .eq('id', id)
    .select('id, status')
    .single();

  if (error || !data) {
    return Response.json({ ok: false, error: 'Chat no encontrado' }, { status: 404 });
  }

  return Response.json({ ok: true, chatId: data.id, status: data.status });
});

import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/<companyId>/chats/:id/release
 * Devuelve el chat (de LA empresa) al bot (status='bot'). Lo usa el operario al
 * terminar de atender un caso atípico desde el panel.
 */
export const POST = withTenant<{ companyId: string; id: string }>(async (_request, ctx, params) => {
  const { id } = params;

  const { data, error } = await ctx.db
    .from('chats')
    .update({ status: 'bot' })
    .eq('company_id', ctx.company.id)
    .eq('id', id)
    .select('id, status')
    .single();

  if (error || !data) {
    return Response.json({ ok: false, error: 'Chat no encontrado' }, { status: 404 });
  }

  return Response.json({ ok: true, chatId: data.id, status: data.status });
});

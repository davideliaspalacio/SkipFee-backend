import { chatStatsByPhone } from '@/lib/chat-stats';
import { serializeChat } from '@/lib/serializers';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/<companyId>/chats?status=bot|human|pending
 * Lista chats de LA empresa ordenados por última actividad (más reciente primero).
 * prevOrders/avgTicket se calculan on-the-fly desde `orders` (entregados)
 * agrupando por teléfono; las columnas homónimas en `chats` quedaron sin uso.
 *
 * Aislamiento: `ctx.db` (JWT del usuario, RLS = capa 2) + `.eq('company_id', ...)`.
 */
export const GET = withTenant(async (request, ctx) => {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const phone = url.searchParams.get('phone')?.trim();

  let query = ctx.db
    .from('chats')
    .select('id, name, phone, last, time, unread, status, zone_id, last_message_at')
    .eq('company_id', ctx.company.id)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(phone ? 1 : 200);

  if (status) query = query.eq('status', status);
  if (phone) query = query.in('phone', phoneCandidates(phone));

  const { data, error } = await query;
  if (error) {
    console.error('[chats GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = data ?? [];
  const stats = await chatStatsByPhone(rows.map(r => r.phone), ctx.company.id);
  const chats = rows.map(r => serializeChat(r, stats.get(r.phone)));
  return Response.json({ ok: true, chats });
});

function phoneCandidates(input: string): string[] {
  const raw = input.trim();
  const digits = raw.replace(/\D/g, '');
  return Array.from(new Set([
    raw,
    digits,
    digits ? `+${digits}` : '',
  ].filter(Boolean)));
}

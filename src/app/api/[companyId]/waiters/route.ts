import { z } from 'zod';
import { withTenant } from '@/lib/tenant';
import { WAITER_SELECT, serializeWaiter, type WaiterRow } from '@/lib/dinein';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/<companyId>/waiters — meseros de LA empresa (con `?all=1` incluye
 * archivados). Privado (panel admin).
 */
export const GET = withTenant(async (request, ctx) => {
  const includeArchived = new URL(request.url).searchParams.get('all') === '1';

  let query = ctx.db
    .from('waiters')
    .select(WAITER_SELECT)
    .eq('company_id', ctx.company.id)
    .order('created_at');
  if (!includeArchived) query = query.eq('archived', false);

  const { data, error } = await query;
  if (error) {
    console.error('[waiters GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as unknown as WaiterRow[];
  return Response.json({ ok: true, waiters: rows.map(serializeWaiter) });
});

const createSchema = z.object({
  name: z.string().min(1).max(60),
  phone: z.string().max(30).optional(),
});

/** POST /api/<companyId>/waiters — crea un mesero. El `id` se autogenera (uuid). */
export const POST = withTenant(async (request, ctx) => {
  let body;
  try {
    body = createSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { data, error } = await ctx.db
    .from('waiters')
    .insert({ company_id: ctx.company.id, name: body.name, phone: body.phone ?? null })
    .select(WAITER_SELECT)
    .single();

  if (error || !data) {
    console.error('[waiters POST] error', error);
    return Response.json(
      { ok: false, error: error?.message ?? 'No se pudo crear el mesero' },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, waiter: serializeWaiter(data as unknown as WaiterRow) }, { status: 201 });
});

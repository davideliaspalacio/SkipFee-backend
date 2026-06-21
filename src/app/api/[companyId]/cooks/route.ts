import { z } from 'zod';
import { hoursSchema } from '@/lib/hours-schema';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SELECT = 'id, name, hours, archived, created_at';

/**
 * GET /api/<companyId>/cooks — cocineros de LA empresa (con `?all=1` incluye
 * archivados, para el admin). Privado (panel admin).
 */
export const GET = withTenant(async (request, ctx) => {
  const includeArchived = new URL(request.url).searchParams.get('all') === '1';

  let query = ctx.db
    .from('cooks')
    .select(SELECT)
    .eq('company_id', ctx.company.id)
    .order('created_at');
  if (!includeArchived) query = query.eq('archived', false);

  const { data, error } = await query;
  if (error) {
    console.error('[cooks GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true, cooks: data ?? [] });
});

const createSchema = z.object({
  name: z.string().min(1).max(60),
  hours: hoursSchema.optional(), // sin horario → fail-open (disponible siempre)
});

/** POST /api/<companyId>/cooks — crea un cocinero. El `id` se autogenera (uuid). */
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
    .from('cooks')
    .insert({ company_id: ctx.company.id, name: body.name, hours: body.hours ?? null })
    .select(SELECT)
    .single();

  if (error || !data) {
    console.error('[cooks POST] error', error);
    return Response.json(
      { ok: false, error: error?.message ?? 'No se pudo crear el cocinero' },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, cook: data }, { status: 201 });
});

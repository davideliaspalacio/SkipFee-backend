import { z } from 'zod';
import { withTenant } from '@/lib/tenant';
import { TABLE_SELECT, serializeTable, type DiningTableRow } from '@/lib/dinein';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/<companyId>/tables — mesas de LA empresa (con `?all=1` incluye
 * archivadas). Privado (panel admin). Ordenadas por código.
 */
export const GET = withTenant(async (request, ctx) => {
  const includeArchived = new URL(request.url).searchParams.get('all') === '1';

  let query = ctx.db
    .from('dining_tables')
    .select(TABLE_SELECT)
    .eq('company_id', ctx.company.id)
    .order('code');
  if (!includeArchived) query = query.eq('archived', false);

  const { data, error } = await query;
  if (error) {
    console.error('[tables GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as unknown as DiningTableRow[];
  return Response.json({ ok: true, tables: rows.map(serializeTable) });
});

const createSchema = z.object({
  code: z.string().min(1).max(20),
  label: z.string().max(60).optional(),
  area: z.string().max(60).optional(),
  seats: z.number().int().min(1).max(50).optional(),
});

/**
 * POST /api/<companyId>/tables — crea una mesa. El `id` y el `qr_token` se
 * autogeneran. Código duplicado → 409.
 */
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
    .from('dining_tables')
    .insert({
      company_id: ctx.company.id,
      code: body.code,
      label: body.label ?? null,
      area: body.area ?? null,
      seats: body.seats ?? 4,
    })
    .select(TABLE_SELECT)
    .single();

  if (error || !data) {
    const isDup = error?.code === '23505';
    if (!isDup) console.error('[tables POST] error', error);
    return Response.json(
      { ok: false, error: isDup ? 'Ya existe una mesa con ese código' : error?.message ?? 'No se pudo crear la mesa' },
      { status: isDup ? 409 : 500 },
    );
  }
  return Response.json({ ok: true, table: serializeTable(data as unknown as DiningTableRow) }, { status: 201 });
});

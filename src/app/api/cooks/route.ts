import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { hoursSchema } from '@/lib/hours-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SELECT = 'id, name, hours, archived, created_at';

/**
 * GET /api/cooks — cocineros activos (con `?all=1` incluye archivados, para el admin).
 * Privado (panel admin), igual que /api/zones y /api/settings.
 */
export async function GET(request: NextRequest) {
  const includeArchived = new URL(request.url).searchParams.get('all') === '1';

  let query = supabaseAdmin().from('cooks').select(SELECT).order('created_at');
  if (!includeArchived) query = query.eq('archived', false);

  const { data, error } = await query;
  if (error) {
    console.error('[cooks GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true, cooks: data ?? [] });
}

const createSchema = z.object({
  name: z.string().min(1).max(60),
  hours: hoursSchema.optional(), // sin horario → fail-open (disponible siempre)
});

/** POST /api/cooks — crea un cocinero. El `id` se autogenera (uuid). */
export async function POST(request: NextRequest) {
  let body;
  try {
    body = createSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin()
    .from('cooks')
    .insert({ name: body.name, hours: body.hours ?? null })
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
}

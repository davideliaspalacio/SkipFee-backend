import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SELECT = 'id, name, tarifa, recargo, color, lat, lng, archived, coverage, coverageRadiusM:coverage_radius_m';

/**
 * GET /api/zones — zonas activas (con `?all=1` incluye archivadas, para el admin).
 *
 * NOTA: requiere la migración 0017 (columna `archived`).
 */
export async function GET(request: NextRequest) {
  const includeArchived = new URL(request.url).searchParams.get('all') === '1';

  let query = supabaseAdmin().from('zones').select(SELECT).order('name');
  if (!includeArchived) query = query.eq('archived', false);

  const { data, error } = await query;
  if (error) {
    console.error('[zones GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true, zones: data ?? [] });
}

/** Slug ASCII a partir del nombre (para el id de la zona). */
function slugify(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'zona';
}

const coverageSchema = z.array(z.object({ lat: z.number(), lng: z.number() })).min(3);

const createSchema = z.object({
  name: z.string().min(1).max(60),
  tarifa: z.number().int().nonnegative(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  coverage: coverageSchema.nullable().optional(),
  coverageRadiusM: z.number().int().positive().nullable().optional(),
});

/**
 * POST /api/zones — crea una zona. El `id` se genera como slug del nombre
 * (con sufijo numérico si choca). `recargo` queda en 0 (hora pico eliminada).
 */
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

  const sb = supabaseAdmin();

  // id único basado en el slug
  const base = slugify(body.name);
  let id = base;
  for (let i = 2; i < 100; i++) {
    const { data: existing } = await sb.from('zones').select('id').eq('id', id).maybeSingle();
    if (!existing) break;
    id = `${base}-${i}`;
  }

  const { data, error } = await sb
    .from('zones')
    .insert({
      id,
      name: body.name,
      tarifa: body.tarifa,
      recargo: 0, // hora pico eliminada
      color: body.color ?? '#5E6AD2',
      lat: body.lat ?? 6.2442, // centro de Medellín por defecto
      lng: body.lng ?? -75.5812,
      coverage: body.coverage ?? null,
      coverage_radius_m: body.coverageRadiusM ?? null,
    })
    .select(SELECT)
    .single();

  if (error || !data) {
    console.error('[zones POST] error', error);
    return Response.json({ ok: false, error: error?.message ?? 'No se pudo crear la zona' }, { status: 500 });
  }
  return Response.json({ ok: true, zone: data }, { status: 201 });
}

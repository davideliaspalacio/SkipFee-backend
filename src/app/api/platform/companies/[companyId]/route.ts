import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { requirePlatformAdmin } from '@/lib/tenant';
import { estadoDeSuscripcion, platformSettings } from '@/lib/trial';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/platform/companies/:companyId — ficha de UNA empresa (solo owner).
 *
 * `:companyId` acepta el code numérico (1007) o el slug ('la-parrilla'), igual
 * que el resto de rutas de negocio.
 *
 * Antes de esto, suspender a un moroso o extenderle la prueba a alguien exigía
 * un UPDATE a mano en SQL. Ahora es un PATCH.
 */

const patchSchema = z.object({
  status: z.enum(['active', 'suspended']).optional(),
  plan: z.enum(['trial', 'activo', 'cortesia']).optional(),
  name: z.string().min(1).max(120).optional(),
  /** Extiende (o acorta, con negativo) la prueba en días desde su fin actual. */
  extenderDias: z.number().int().min(-365).max(365).optional(),
  /** Reinicia el reloj: la prueba vuelve a arrancar hoy con los días de plataforma. */
  reiniciarTrial: z.boolean().optional(),
});

const COLUMNAS = 'id, code, slug, name, status, plan, trial_started_at, trial_ends_at, created_at';

async function buscarEmpresa(companyId: string) {
  const sb = supabaseAdmin();
  const esCode = /^\d+$/.test(companyId);
  const { data, error } = await sb
    .from('companies')
    .select(COLUMNAS)
    .eq(esCode ? 'code' : 'slug', esCode ? Number(companyId) : companyId)
    .maybeSingle();
  return { data, error };
}

function serializar(row: Record<string, unknown>) {
  return {
    id: row.id,
    code: row.code,
    slug: row.slug,
    name: row.name,
    createdAt: row.created_at,
    ...estadoDeSuscripcion(row as Parameters<typeof estadoDeSuscripcion>[0]),
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const auth = await requirePlatformAdmin(request);
  if ('error' in auth) {
    return Response.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const { companyId } = await params;
  const { data, error } = await buscarEmpresa(companyId);

  if (error) {
    console.error('[platform/companies/:id] get error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json({ ok: false, error: 'Empresa no encontrada' }, { status: 404 });
  }

  return Response.json({ ok: true, company: serializar(data) });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const auth = await requirePlatformAdmin(request);
  if ('error' in auth) {
    return Response.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  let body;
  try {
    body = patchSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { companyId } = await params;
  const actual = await buscarEmpresa(companyId);
  if (actual.error) {
    return Response.json({ ok: false, error: actual.error.message }, { status: 500 });
  }
  if (!actual.data) {
    return Response.json({ ok: false, error: 'Empresa no encontrada' }, { status: 404 });
  }

  const update: Record<string, unknown> = {};
  if (body.status !== undefined) update.status = body.status;
  if (body.plan !== undefined) update.plan = body.plan;
  if (body.name !== undefined) update.name = body.name;

  if (body.reiniciarTrial) {
    const { trialDays } = await platformSettings();
    const ahora = new Date();
    update.plan = body.plan ?? 'trial';
    update.trial_started_at = ahora.toISOString();
    update.trial_ends_at = new Date(ahora.getTime() + trialDays * 86_400_000).toISOString();
  } else if (body.extenderDias !== undefined) {
    // Desde el fin actual si la prueba sigue viva; desde hoy si ya venció —
    // extender tres días una prueba que venció hace un mes no le sirve a nadie.
    const finActual = actual.data.trial_ends_at
      ? new Date(actual.data.trial_ends_at as string).getTime()
      : Date.now();
    const base = Math.max(finActual, Date.now());
    update.trial_ends_at = new Date(base + body.extenderDias * 86_400_000).toISOString();
    if (!actual.data.trial_started_at) update.trial_started_at = new Date().toISOString();
  }

  if (Object.keys(update).length === 0) {
    return Response.json({ ok: false, error: 'Nada que actualizar' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin()
    .from('companies')
    .update(update)
    .eq('id', actual.data.id as string)
    .select(COLUMNAS)
    .single();

  if (error) {
    console.error('[platform/companies/:id] update error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true, company: serializar(data) });
}

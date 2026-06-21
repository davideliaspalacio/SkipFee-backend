import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/products/available?company=<slug>   (o ?companyId=<uuid>)
 *
 * Pública (sin sesión): la tienda web pide el catálogo de UNA empresa. El slug le
 * llega en el link de WhatsApp; lo resolvemos a la empresa y scopeamos los
 * productos por `company_id`. Devuelve productos disponibles agrupados por
 * categoría.
 *
 * Usa `supabaseAdmin()` (service_role) porque es una ruta pública sin usuario; el
 * aislamiento lo da el filtro obligatorio `.eq('company_id', …)`.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const slug = searchParams.get('company')?.trim();
  const companyIdParam = searchParams.get('companyId')?.trim();

  if (!slug && !companyIdParam) {
    return Response.json(
      { ok: false, error: 'Falta ?company=<slug> (o ?companyId=<uuid>)' },
      { status: 400 },
    );
  }

  const admin = supabaseAdmin();

  // Resolver la empresa (por slug o por id) y validar que esté activa.
  let companyQuery = admin.from('companies').select('id, status');
  companyQuery = companyIdParam
    ? companyQuery.eq('id', companyIdParam)
    : companyQuery.eq('slug', slug as string);
  const { data: company, error: companyErr } = await companyQuery.maybeSingle();

  if (companyErr) {
    console.error('[products/available] company lookup error', companyErr);
    return Response.json({ ok: false, error: companyErr.message }, { status: 500 });
  }
  if (!company) {
    return Response.json({ ok: false, error: 'Empresa no encontrada' }, { status: 404 });
  }
  if (company.status === 'suspended') {
    return Response.json({ ok: false, error: 'Empresa suspendida' }, { status: 403 });
  }

  const { data, error } = await admin
    .from('products')
    .select('id, name, price, cat')
    .eq('company_id', company.id)
    .eq('available', true)
    .eq('archived', false)
    .order('cat')
    .order('name');

  if (error) {
    console.error('[products/available] db error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Agrupar por categoría para que la tienda/bot pueda mostrar secciones
  const byCategory = new Map<string, Array<{ id: string; name: string; price: number }>>();
  for (const p of data ?? []) {
    const list = byCategory.get(p.cat) ?? [];
    list.push({ id: p.id, name: p.name, price: p.price });
    byCategory.set(p.cat, list);
  }

  const categories = Array.from(byCategory.entries()).map(([name, items]) => ({
    name,
    items,
  }));

  return Response.json({ ok: true, categories });
}

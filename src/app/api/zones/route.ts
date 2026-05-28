import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/zones
 * Devuelve las zonas con tarifa, recargo, color y coordenadas (para mapas).
 */
export async function GET() {
  const { data, error } = await supabaseAdmin()
    .from('zones')
    .select('id, name, tarifa, recargo, color, lat, lng')
    .order('name');

  if (error) {
    console.error('[zones GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true, zones: data ?? [] });
}

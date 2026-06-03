import { getAdminCatalog } from '@/lib/bot/messages/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/bot/messages — catálogo completo de mensajes del bot para el panel
 * admin: metadata (label, categoría, step, kind, variables) + contenido resuelto
 * (default ⊕ override) + el default de referencia + isCustomized/enabled.
 *
 * Ruta privada (middleware exige sesión). El bot NO usa esta API: lee el
 * catálogo directo vía `getMessage`.
 */
export async function GET() {
  try {
    const messages = await getAdminCatalog();
    return Response.json({ ok: true, messages });
  } catch (err) {
    console.error('[bot messages GET] error', err);
    return Response.json({ ok: false, error: 'No se pudo cargar el catálogo' }, { status: 500 });
  }
}

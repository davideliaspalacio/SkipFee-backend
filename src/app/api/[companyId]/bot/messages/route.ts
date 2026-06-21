import { getAdminCatalog } from '@/lib/bot/messages/catalog';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/<companyId>/bot/messages — catálogo completo de mensajes del bot para
 * el panel admin: metadata (label, categoría, step, kind, variables) + contenido
 * resuelto (default ⊕ override) + el default de referencia + isCustomized/enabled.
 *
 * Ruta privada (withTenant exige sesión + pertenencia). El bot NO usa esta API:
 * lee el catálogo directo vía `getMessage`.
 *
 * TODO(multi-empresa, transversal): `getAdminCatalog`/`getMessage` (catalog.ts)
 * leen `bot_messages` SIN scope por empresa (cache global compartida con el bot).
 * Falta pasarle `companyId` para resolver overrides por empresa. Helper
 * compartido (bot/cron/webhooks) → lo migra otro agente.
 */
export const GET = withTenant(async () => {
  try {
    const messages = await getAdminCatalog();
    return Response.json({ ok: true, messages });
  } catch (err) {
    console.error('[bot messages GET] error', err);
    return Response.json({ ok: false, error: 'No se pudo cargar el catálogo' }, { status: 500 });
  }
});

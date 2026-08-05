export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/wompi/webhook  (compat single-tenant, la URL ORIGINAL)
 *
 * Es la URL de eventos que quedó registrada en el panel de Wompi antes de
 * multi-empresa — sigue listada como ruta pública en `lib/checkout/access.ts`,
 * pero el archivo se perdió en la migración y hoy responde 404. Wompi no
 * reintenta indefinidamente ni avisa: el comercio cobra y el pedido se queda
 * en `borrador` sin traza.
 *
 * Delega en el mismo handler que la URL sin slug, que a su vez resuelve la
 * empresa por defecto (`WOMPI_LEGACY_COMPANY_SLUG`).
 */
export { POST } from '../../webhooks/wompi/route';

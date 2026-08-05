import type { NextRequest } from 'next/server';
import { POST as postForCompany } from './[companyId]/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/wompi  (compat single-tenant)
 *
 * Antes de multi-empresa esta era LA url de eventos de Wompi, y es la que
 * quedó registrada en el panel del comercio original. Al añadir el slug
 * (`/api/webhooks/wompi/<slug>`) esta ruta desapareció y Wompi empezó a
 * recibir 404: el pago se cobraba pero el pedido se quedaba en `borrador`
 * sin ninguna traza, porque un 404 no deja log ni fila en la BD.
 *
 * Mantenemos la ruta viva apuntando a la empresa por defecto para no depender
 * de que alguien reconfigure el panel de Wompi. Las empresas nuevas usan su
 * URL con slug; esta solo cubre a la que existía antes de la migración.
 *
 * `WOMPI_LEGACY_COMPANY_SLUG` permite cambiar a qué empresa apunta sin tocar
 * código. Si algún día no queda nadie usando la URL vieja, se borra el archivo.
 */
const LEGACY_SLUG = process.env.WOMPI_LEGACY_COMPANY_SLUG || 'bros-and-subs';

export async function POST(request: NextRequest) {
  console.log('[wompi webhook] url legacy sin slug → empresa por defecto', { slug: LEGACY_SLUG });
  return postForCompany(request, { params: Promise.resolve({ companyId: LEGACY_SLUG }) });
}

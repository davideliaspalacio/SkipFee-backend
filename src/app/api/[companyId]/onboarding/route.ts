import { withTenant } from '@/lib/tenant';
import { supabaseAdmin } from '@/lib/db';
import { getCompanyIntegrations } from '@/lib/integrations';
import { evolutionSesionConectada } from '@/lib/whatsapp/evolution/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/<code>/onboarding — qué le falta al negocio para poder vender.
 *
 * El estado se CALCULA de los datos reales, nunca de casillas que alguien marcó.
 * Un checklist que se completa a mano miente: dice "carta lista" cuando el dueño
 * tocó el botón, no cuando hay productos.
 *
 * El último paso —`primerPedido`— es el único que importa de verdad. La métrica
 * de activación no es "carta completa", es "recibiste un pedido": un negocio
 * puede tener todo configurado y no haber vendido nunca, y ese es el que hay que
 * llamar.
 */

export interface PasoOnboarding {
  id: 'negocio' | 'carta' | 'zona' | 'whatsapp' | 'primerPedido';
  titulo: string;
  descripcion: string;
  hecho: boolean;
  /** Bloquea la venta: sin esto el bot no puede cerrar un pedido. */
  obligatorio: boolean;
  detalle?: string;
}

export const GET = withTenant(async (_request, ctx) => {
  const sb = supabaseAdmin();
  const companyId = ctx.company.id;

  const [settingsRes, productosRes, zonasRes, pedidosRes, integraciones] = await Promise.all([
    sb
      .from('settings')
      .select('business_description, local_lat, local_lng, local_label')
      .eq('company_id', companyId)
      .maybeSingle(),
    sb
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('archived', false)
      .eq('available', true),
    sb
      .from('zones')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('archived', false),
    sb
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .neq('status', 'borrador'),
    getCompanyIntegrations(companyId).catch(() => null),
  ]);

  const s = settingsRes.data;
  const productos = productosRes.count ?? 0;
  const zonas = zonasRes.count ?? 0;
  const pedidos = pedidosRes.count ?? 0;

  // "Datos del negocio" = lo que la 0049 dejó de heredar del piloto y ahora
  // nace vacío: cómo se describe y dónde queda.
  const negocioListo = !!(s?.business_description && s?.local_lat && s?.local_lng);

  const whatsappListo = integraciones
    ? integraciones.whatsapp_provider === 'evolution'
      ? evolutionSesionConectada(integraciones.evolution_session_state)
      : !!(integraciones.kapso_api_key && integraciones.kapso_phone_number_id)
    : false;

  const pasos: PasoOnboarding[] = [
    {
      id: 'negocio',
      titulo: 'Cuéntanos de tu negocio',
      descripcion: 'Tu dirección y en qué se especializan. El bot lo usa para presentarse.',
      hecho: negocioListo,
      obligatorio: false,
    },
    {
      id: 'carta',
      titulo: 'Sube tu carta',
      descripcion: 'Mándanos una foto y la digitalizamos. Tú solo revisas.',
      hecho: productos > 0,
      obligatorio: true,
      detalle:
        productos > 0
          ? `${productos} ${productos === 1 ? 'producto disponible' : 'productos disponibles'}`
          : undefined,
    },
    {
      id: 'zona',
      titulo: 'Define hasta dónde repartes',
      descripcion: 'Sin esto el bot no puede cerrar un domicilio.',
      hecho: zonas > 0,
      obligatorio: true,
      detalle: zonas > 0 ? `${zonas} ${zonas === 1 ? 'zona' : 'zonas'}` : undefined,
    },
    {
      id: 'whatsapp',
      titulo: 'Conecta tu WhatsApp',
      descripcion: 'Es por donde te van a escribir tus clientes.',
      hecho: whatsappListo,
      obligatorio: true,
    },
    {
      id: 'primerPedido',
      titulo: 'Recibe tu primer pedido',
      descripcion: 'Escríbele a tu propio WhatsApp para probarlo de punta a punta.',
      hecho: pedidos > 0,
      obligatorio: false,
      detalle: pedidos > 0 ? `${pedidos} ${pedidos === 1 ? 'pedido' : 'pedidos'}` : undefined,
    },
  ];

  const obligatoriosPendientes = pasos.filter(p => p.obligatorio && !p.hecho);
  const puedeVender = obligatoriosPendientes.length === 0;

  // La primera vez que el negocio queda operativo se sella la fecha. De ahí en
  // adelante, que se le caiga WhatsApp es un canal caído —no un negocio sin
  // montar— y ni se le cierra el panel ni se le repite el onboarding.
  // Idempotente: el WHERE solo aplica si sigue en null.
  if (puedeVender) {
    await sb
      .from('companies')
      .update({ operativo_desde: new Date().toISOString() })
      .eq('id', companyId)
      .is('operativo_desde', null);
  }

  return Response.json({
    ok: true,
    pasos,
    /** Puede vender: tiene carta, zona y WhatsApp. */
    puedeVender,
    /** Ya vendió: el hito que de verdad indica activación. */
    activo: pedidos > 0,
    completados: pasos.filter(p => p.hecho).length,
    total: pasos.length,
    siguiente: obligatoriosPendientes[0]?.id ?? pasos.find(p => !p.hecho)?.id ?? null,
  });
});

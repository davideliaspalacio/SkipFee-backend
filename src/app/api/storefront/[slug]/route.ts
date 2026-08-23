import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { jsonWithCors, preflight } from '@/lib/checkout/cors';
import { isOpenNow, nextOpeningLabel, type WeekHours } from '@/lib/hours';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/storefront/<slug>
 *
 * Todo lo que necesita la tienda de un negocio para pintarse a alguien que
 * llega en FRÍO — sin haber hablado con el bot, sin pedido, sin link: quién es,
 * si está abierto ahora y qué vende.
 *
 * Va en una sola llamada a propósito. Es lo primero que ve un cliente que entró
 * a `arepas.skipfee.co`, muchas veces desde datos móviles: encadenar tres
 * peticiones para pintar una carta es regalar el primer segundo, que es justo
 * el que decide si se queda.
 *
 * Público (sin sesión) y sin secretos: es una vitrina. Lo mismo que cualquiera
 * vería parado frente al local. Usa `service_role` porque no hay usuario, y el
 * aislamiento lo da el filtro obligatorio por `company_id`.
 */

export async function OPTIONS() {
  return preflight();
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const admin = supabaseAdmin();

  const { data: company, error: companyErr } = await admin
    .from('companies')
    .select('id, name, slug, status')
    .eq('slug', slug.toLowerCase())
    .maybeSingle();

  if (companyErr) {
    console.error('[storefront] company lookup error', companyErr);
    return jsonWithCors({ ok: false, error: companyErr.message }, 500);
  }

  // Un negocio que no existe y uno suspendido se ven igual desde afuera: 404.
  // Decir "suspendido" le contaría a cualquiera que ese restaurante dejó de
  // pagar, y eso no es asunto de quien pasaba por ahí.
  if (!company || company.status !== 'active') {
    return jsonWithCors({ ok: false, error: 'Tienda no encontrada' }, 404);
  }

  const [ajustes, productos] = await Promise.all([
    admin
      .from('settings')
      .select('business_description, logo_url, brand_color, hours, orders_paused, base_delivery_fee')
      .eq('company_id', company.id)
      .maybeSingle(),
    admin
      .from('products')
      .select('id, name, price, cat, description, img')
      .eq('company_id', company.id)
      .eq('available', true)
      .eq('archived', false)
      .order('cat')
      .order('name'),
  ]);

  if (productos.error) {
    console.error('[storefront] products error', productos.error);
    return jsonWithCors({ ok: false, error: productos.error.message }, 500);
  }

  const s = ajustes.data;
  const horarios = (s?.hours ?? {}) as WeekHours;
  const ahora = new Date();

  // Un negocio recién dado de alta no ha tocado sus horarios, y `isOpenNow` con
  // la semana vacía responde "cerrado" — cerrado hoy, mañana y siempre, sin una
  // próxima apertura que mostrar. Su tienda nacería muerta por una casilla que
  // nadie le pidió llenar. Sin horarios se asume ABIERTO, igual que
  // `cooks.hours = null` significa "disponible siempre" en el resto del sistema:
  // el dueño cierra cuando decide cerrar, no por omisión.
  const sinHorarios = Object.keys(horarios).length === 0;
  const abierto = sinHorarios || isOpenNow(horarios, ahora);
  const pausado = s?.orders_paused === true;

  const categorias = agruparPorCategoria(productos.data ?? []);

  return jsonWithCors({
    ok: true,
    negocio: {
      slug: company.slug,
      nombre: company.name,
      descripcion: s?.business_description ?? null,
      logoUrl: s?.logo_url ?? null,
      colorMarca: s?.brand_color ?? null,
      domicilioBase: s?.base_delivery_fee ?? null,
    },
    // `recibePedidos` es lo que la tienda tiene que mirar: junta las dos razones
    // por las que hoy no se puede pedir —fuera de horario o pausado a mano— para
    // que la pantalla no tenga que reimplementar esa lógica y equivocarse.
    estado: {
      abierto,
      pausado,
      recibePedidos: abierto && !pausado,
      proximaApertura: abierto ? null : nextOpeningLabel(horarios, ahora),
      /** true si el dueño nunca configuró horarios: el panel puede recordárselo. */
      sinHorarios,
    },
    categorias,
  });
}

function agruparPorCategoria(
  filas: Array<{
    id: string;
    name: string;
    price: number;
    cat: string;
    description: string | null;
    img: string | null;
  }>,
) {
  const porCat = new Map<string, Array<Record<string, unknown>>>();
  for (const p of filas) {
    const lista = porCat.get(p.cat) ?? [];
    lista.push({
      id: p.id,
      nombre: p.name,
      precio: p.price,
      descripcion: p.description,
      imagen: p.img,
    });
    porCat.set(p.cat, lista);
  }
  return Array.from(porCat.entries()).map(([nombre, items]) => ({ nombre, items }));
}

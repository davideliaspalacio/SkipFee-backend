import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub, asyncParams, getRequest } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => supabaseStub.client,
}));

import { GET, OPTIONS } from './route';

const PRODUCTS = [
  { id: 'p01', name: 'Pastrami Bros', price: 28000, cat: 'Sándwiches', available: true, img: 'https://cdn/p01.jpg', description: 'Pastrami curado 7 días, mostaza dijon' },
  { id: 'b03', name: 'Limonada', price: 4500, cat: 'Bebidas', available: true, img: '', description: null },
];
const ZONES = [
  { id: 'poblado', name: 'El Poblado', tarifa: 4500, recargo: 1500, color: '#f00', lat: 6.2, lng: -75.5 },
];
// Ventana de hora pico imposible (un solo minuto a las 03:00) para que las
// aserciones de totales sean deterministas sin importar la hora real del runner.
const SETTINGS = { peak_start: '03:00', peak_end: '03:01', base_delivery_fee: 4500 };

function baseTables(orderRow: unknown) {
  return {
    orders: { single: orderRow },
    products: { rows: PRODUCTS },
    zones: { rows: ZONES },
    settings: { single: SETTINGS },
  };
}

const url = (id: string, userId?: string) =>
  `http://localhost:3000/api/checkout/${id}${userId ? `?userId=${userId}` : ''}`;

beforeEach(() => {
  process.env.STOREFRONT_ORIGIN = 'http://localhost:5173';
});

describe('GET /api/checkout/:orderId', () => {
  it('orden borrador válida con carrito ⇒ status valida + cart + catalog + zones', async () => {
    // now fuera de hora pico para peakSurcharge 0
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const order = {
      id: 'o1',
      phone: '573136913188',
      status: 'borrador',
      expires_at: future,
      address: 'Cra 1 #2-3',
      zone_id: 'poblado',
      lat: 6.2,
      lng: -75.5,
      note: null,
      customer: { name: 'Ana', email: null },
      items: [
        { qty: 2, price_at_order: 28000, product: { id: 'p01', name: 'Pastrami Bros' } },
      ],
    };
    supabaseStub = makeSupabaseStub(baseTables(order));

    const res = await GET(getRequest(url('o1', '573136913188')), asyncParams({ orderId: 'o1' }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.status).toBe('valida');
    expect(body.order.orderId).toBe('o1');
    expect(body.order.phone).toBe('573136913188');
    expect(body.order.expiresAt).toBe(future);
    expect(body.order.cart.items).toEqual([
      { productId: 'p01', name: 'Pastrami Bros', qty: 2, price: 28000, lineTotal: 56000 },
    ]);
    expect(body.order.cart.subtotal).toBe(56000);
    expect(body.order.cart.delivery).toBe(4500);
    expect(body.order.cart.total).toBe(60500);
    expect(body.order.delivery).toEqual({ address: 'Cra 1 #2-3', zoneId: 'poblado', lat: 6.2, lng: -75.5 });
    expect(body.order.customer).toEqual({ name: 'Ana', email: null });

    // Catálogo embebido agrupado por categoría
    expect(body.catalog.categories[0].cat).toBe('Sándwiches');
    expect(body.catalog.categories[0].items[0]).toEqual({
      id: 'p01',
      name: 'Pastrami Bros',
      price: 28000,
      cat: 'Sándwiches',
      img: 'https://cdn/p01.jpg',
      description: 'Pastrami curado 7 días, mostaza dijon',
    });
    // Producto sin imagen (img:'' en BD) ⇒ catalog devuelve null para que el
    // storefront renderice el placeholder en vez de un <img src=""> roto.
    expect(body.catalog.categories[1].items[0].img).toBe(null);
    // Producto sin descripción (description:null en BD) ⇒ se mantiene null,
    // el storefront simplemente no renderiza el <p>.
    expect(body.catalog.categories[1].items[0].description).toBe(null);
    // Zonas
    expect(body.zones).toEqual([{ id: 'poblado', name: 'El Poblado', tarifa: 4500, recargo: 1500 }]);

    // siempre 200
  });

  it('orden borrador sin items ⇒ cart vacío (items [], totales 0)', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const order = {
      id: 'o1', phone: '573136913188', status: 'borrador', expires_at: future,
      address: null, zone_id: null, lat: null, lng: null, note: null,
      customer: null, items: [],
    };
    supabaseStub = makeSupabaseStub(baseTables(order));
    const res = await GET(getRequest(url('o1')), asyncParams({ orderId: 'o1' }));
    const body = await res.json();
    expect(body.status).toBe('valida');
    expect(body.order.cart).toEqual({ items: [], subtotal: 0, delivery: 0, peakSurcharge: 0, total: 0 });
    expect(body.order.delivery).toBeNull();
    expect(body.order.customer).toBeNull();
  });

  it('borrador vencida ⇒ 200 status expirada (sin order)', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const order = { id: 'o1', phone: 'x', status: 'borrador', expires_at: past, items: [] };
    supabaseStub = makeSupabaseStub(baseTables(order));
    const res = await GET(getRequest(url('o1')), asyncParams({ orderId: 'o1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, status: 'expirada' });
  });

  it('orden no encontrada ⇒ 200 status no_encontrada', async () => {
    supabaseStub = makeSupabaseStub(baseTables(null));
    const res = await GET(getRequest(url('nope')), asyncParams({ orderId: 'nope' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'no_encontrada' });
  });

  it('orden ya pagada/en kanban ⇒ 200 status ya_usada + order{orderStatus, orderNumber}', async () => {
    const order = {
      id: 'o1', phone: 'x', status: 'cocina', expires_at: null,
      order_number: 1234, items: [],
    };
    supabaseStub = makeSupabaseStub(baseTables(order));
    const res = await GET(getRequest(url('o1')), asyncParams({ orderId: 'o1' }));
    expect(await res.json()).toEqual({
      ok: true,
      status: 'ya_usada',
      order: { orderId: 'o1', orderStatus: 'cocina', orderNumber: 1234 },
    });
  });

  it('ya_usada sin order_number ⇒ orderNumber: null', async () => {
    const order = { id: 'o1', phone: 'x', status: 'pagado', expires_at: null, items: [] };
    supabaseStub = makeSupabaseStub(baseTables(order));
    const res = await GET(getRequest(url('o1')), asyncParams({ orderId: 'o1' }));
    const body = await res.json();
    expect(body.status).toBe('ya_usada');
    expect(body.order.orderStatus).toBe('pagado');
    expect(body.order.orderNumber).toBeNull();
  });

  it('respuesta lleva headers CORS', async () => {
    supabaseStub = makeSupabaseStub(baseTables(null));
    const res = await GET(getRequest(url('nope')), asyncParams({ orderId: 'nope' }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });

  it('OPTIONS responde 204', async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
  });

  it('devuelve wompiStatusMessage cuando la orden tiene un rechazo previo', async () => {
    // Caso real: cliente pagó, Wompi DECLINED, webhook volvió la orden a borrador
    // con el motivo guardado. La tienda usa esto para mostrarle "tu pago fue
    // rechazado: <msg>" y ofrecer reintentar.
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const order = {
      id: 'o1', phone: '573136913188', status: 'borrador', expires_at: future,
      address: 'Cra 1 #2-3', zone_id: 'poblado', lat: 6.2, lng: -75.5, note: null,
      wompi_status_message: 'Fondos insuficientes',
      customer: { name: 'Ana', email: null },
      items: [],
    };
    supabaseStub = makeSupabaseStub(baseTables(order));
    const res = await GET(getRequest(url('o1')), asyncParams({ orderId: 'o1' }));
    const body = await res.json();
    expect(body.status).toBe('valida');
    expect(body.order.wompiStatusMessage).toBe('Fondos insuficientes');
  });

  it('wompiStatusMessage es null cuando la orden nunca tuvo intento de pago', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const order = {
      id: 'o1', phone: '573136913188', status: 'borrador', expires_at: future,
      address: null, zone_id: null, lat: null, lng: null, note: null,
      wompi_status_message: null,
      customer: null, items: [],
    };
    supabaseStub = makeSupabaseStub(baseTables(order));
    const res = await GET(getRequest(url('o1')), asyncParams({ orderId: 'o1' }));
    const body = await res.json();
    expect(body.order.wompiStatusMessage).toBeNull();
  });
});

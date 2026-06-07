import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseStub, jsonRequest, asyncParams } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const updateCapture = vi.fn();
const itemsInsertCapture = vi.fn();
const itemsDeleteCapture = vi.fn();

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => supabaseStub.client,
}));

import { PUT, OPTIONS } from './route';

const PRODUCTS = [
  { id: 'p01', name: 'Pastrami Bros', price: 28000, cat: 'Sándwiches', available: true },
  { id: 'b03', name: 'Limonada', price: 4500, cat: 'Bebidas', available: true },
  { id: 'x99', name: 'Agotado', price: 10000, cat: 'Sándwiches', available: false },
];
const ZONES = [
  { id: 'poblado', name: 'El Poblado', tarifa: 4500, recargo: 1500, color: '#f00', lat: 6.25, lng: -75.56 },
];
// Ventana de hora pico imposible para totales deterministas.
const SETTINGS = { peak_start: '03:00', peak_end: '03:01', base_delivery_fee: 4500 };

function tablesFor(orderRow: unknown) {
  return {
    orders: {
      single: orderRow,
      onUpdate: (payload: unknown, filters: Record<string, unknown>) => {
        updateCapture(payload, filters);
        return {};
      },
    },
    order_items: {
      onInsert: (payload: unknown) => { itemsInsertCapture(payload); return {}; },
      onDelete: (filters: Record<string, unknown>) => { itemsDeleteCapture(filters); return {}; },
    },
    products: { rows: PRODUCTS },
    zones: { rows: ZONES },
    settings: { single: SETTINGS },
  };
}

const URL = 'http://localhost:3000/api/checkout/o1/cart';

beforeEach(() => {
  process.env.STOREFRONT_ORIGIN = 'http://localhost:5173';
  updateCapture.mockReset();
  itemsInsertCapture.mockReset();
  itemsDeleteCapture.mockReset();
});

function validBorrador() {
  return {
    id: 'o1',
    status: 'borrador',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    zone_id: 'poblado', // la zona la dejó el bot en la orden
  };
}

describe('PUT /api/checkout/:orderId/cart', () => {
  it('reemplaza items + delivery, recalcula y persiste (sigue borrador)', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(validBorrador()));
    const res = await PUT(
      jsonRequest(URL, 'PUT', {
        items: [{ productId: 'p01', qty: 2 }, { productId: 'b03', qty: 1 }],
        delivery: { address: 'Cra 1 #2-3', zoneId: 'poblado', lat: 6.2, lng: -75.5 },
      }),
      asyncParams({ orderId: 'o1' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.cart.items).toEqual([
      { productId: 'p01', name: 'Pastrami Bros', qty: 2, price: 28000, lineTotal: 56000 },
      { productId: 'b03', name: 'Limonada', qty: 1, price: 4500, lineTotal: 4500 },
    ]);
    expect(body.cart.subtotal).toBe(60500);
    expect(body.cart.delivery).toBe(4500);
    expect(body.cart.total).toBe(65000);
    expect(body.delivery).toEqual({ address: 'Cra 1 #2-3', zoneId: 'poblado', lat: 6.2, lng: -75.5 });

    // Persistencia: borró items previos, insertó nuevos, y actualizó la orden.
    expect(itemsDeleteCapture).toHaveBeenCalled();
    const inserted = itemsInsertCapture.mock.calls[0][0];
    expect(inserted).toEqual([
      { order_id: 'o1', product_id: 'p01', qty: 2, price_at_order: 28000 },
      { order_id: 'o1', product_id: 'b03', qty: 1, price_at_order: 4500 },
    ]);
    const [updPayload] = updateCapture.mock.calls[0];
    expect(updPayload.address).toBe('Cra 1 #2-3');
    expect(updPayload.zone_id).toBe('poblado');
    expect(updPayload.total).toBe(65000);
    expect(updPayload.status).toBeUndefined(); // sigue borrador, no se toca status
  });

  it('editar SOLO items (sin delivery) usa la zona guardada ⇒ el domicilio NO queda en 0', async () => {
    // Regresión: la entrega es read-only (la pone el bot). Al cambiar items el
    // body no trae zoneId; debe caer a order.zone_id y cobrar zone.tarifa.
    supabaseStub = makeSupabaseStub(tablesFor(validBorrador()));
    const res = await PUT(
      jsonRequest(URL, 'PUT', { items: [{ productId: 'p01', qty: 1 }] }),
      asyncParams({ orderId: 'o1' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cart.delivery).toBe(4500); // tarifa de la zona guardada, no 0
    expect(body.cart.total).toBe(28000 + 4500);
  });

  it('delivery sin lat/lng usa las coords de la zona como fallback al persistir', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(validBorrador()));
    const res = await PUT(
      jsonRequest(URL, 'PUT', {
        items: [{ productId: 'p01', qty: 1 }],
        delivery: { address: 'Sin mapa', zoneId: 'poblado' },
      }),
      asyncParams({ orderId: 'o1' }),
    );
    expect(res.status).toBe(200);
    const [updPayload] = updateCapture.mock.calls[0];
    expect(updPayload.lat).toBe(6.25);
    expect(updPayload.lng).toBe(-75.56);
    const body = await res.json();
    expect(body.delivery).toEqual({ address: 'Sin mapa', zoneId: 'poblado', lat: 6.25, lng: -75.56 });
  });

  it('items vacío vacía el carrito (totales 0)', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(validBorrador()));
    const res = await PUT(jsonRequest(URL, 'PUT', { items: [] }), asyncParams({ orderId: 'o1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cart.items).toEqual([]);
    expect(body.cart.total).toBe(0);
    expect(itemsDeleteCapture).toHaveBeenCalled();
  });

  it('producto no disponible ⇒ 409 con unavailable[]', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(validBorrador()));
    const res = await PUT(
      jsonRequest(URL, 'PUT', { items: [{ productId: 'p01', qty: 1 }, { productId: 'x99', qty: 1 }] }),
      asyncParams({ orderId: 'o1' }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.unavailable).toEqual(['Agotado']);
    expect(updateCapture).not.toHaveBeenCalled();
  });

  it('ignora el producto de regalo si llega en el body (no lo marca "no disponible")', async () => {
    // Regresión: el postre de regalo (available:false) se inyecta como línea $0 y
    // el front lo reenviaba al guardar → el server lo marcaba "no disponible" y
    // rechazaba el carrito. Ahora se filtra por review_gift_product_id.
    const order = { ...validBorrador(), phone: '573000' };
    supabaseStub = makeSupabaseStub({
      ...tablesFor(order),
      products: { rows: [...PRODUCTS, { id: 'gift1', name: 'Postre de regalo', price: 0, cat: 'Regalo', available: false }] },
      settings: { single: { ...SETTINGS, review_gift_product_id: 'gift1' } },
      rewards: { rows: [{ id: 'rw1', phone: '573000', status: 'otorgado' }] },
    });
    const res = await PUT(
      jsonRequest(URL, 'PUT', { items: [{ productId: 'p01', qty: 1 }, { productId: 'gift1', qty: 1 }] }),
      asyncParams({ orderId: 'o1' }),
    );
    expect(res.status).toBe(200); // NO 409
    const body = await res.json();
    expect(body.ok).toBe(true);
    // El gift NO se persiste como item del cliente: solo p01 se inserta.
    const inserted = itemsInsertCapture.mock.calls[0][0];
    expect(inserted).toEqual([{ order_id: 'o1', product_id: 'p01', qty: 1, price_at_order: 28000 }]);
    // El carrito devuelto incluye la línea de regalo inyectada ($0).
    expect(body.cart.items).toContainEqual({ productId: 'gift1', name: 'Postre de regalo', qty: 1, price: 0, lineTotal: 0, gift: true });
  });

  it('orden vencida ⇒ 409 status expirada', async () => {
    supabaseStub = makeSupabaseStub(tablesFor({ id: 'o1', status: 'borrador', expires_at: new Date(Date.now() - 1000).toISOString() }));
    const res = await PUT(jsonRequest(URL, 'PUT', { items: [{ productId: 'p01', qty: 1 }] }), asyncParams({ orderId: 'o1' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe('expirada');
  });

  it('orden ya pagada ⇒ 409 status ya_usada', async () => {
    supabaseStub = makeSupabaseStub(tablesFor({ id: 'o1', status: 'pagado', expires_at: null }));
    const res = await PUT(jsonRequest(URL, 'PUT', { items: [{ productId: 'p01', qty: 1 }] }), asyncParams({ orderId: 'o1' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe('ya_usada');
  });

  it('validación zod ⇒ 400 (qty fuera de rango)', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(validBorrador()));
    const res = await PUT(jsonRequest(URL, 'PUT', { items: [{ productId: 'p01', qty: 0 }] }), asyncParams({ orderId: 'o1' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors).toBeTruthy();
  });

  it('propina 10% ⇒ se calcula sobre el subtotal y se suma al total', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(validBorrador()));
    const res = await PUT(
      jsonRequest(URL, 'PUT', { items: [{ productId: 'p01', qty: 1 }], tipPercent: 10 }),
      asyncParams({ orderId: 'o1' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // subtotal 28000 → tip 2800; + domicilio 4500 → total 35300
    expect(body.cart.tip).toBe(2800);
    expect(body.cart.tipPercent).toBe(10);
    expect(body.cart.total).toBe(28000 + 4500 + 2800);
    const [upd] = updateCapture.mock.calls[0];
    expect(upd.tip).toBe(2800);
    expect(upd.tip_percent).toBe(10);
    expect(upd.total).toBe(35300);
  });

  it('propina custom (monto) ⇒ se suma tal cual y tip_percent es null', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(validBorrador()));
    const res = await PUT(
      jsonRequest(URL, 'PUT', { items: [{ productId: 'p01', qty: 1 }], tip: 3000 }),
      asyncParams({ orderId: 'o1' }),
    );
    const body = await res.json();
    expect(body.cart.tip).toBe(3000);
    expect(body.cart.tipPercent).toBeNull();
    expect(body.cart.total).toBe(28000 + 4500 + 3000);
  });

  it('sin propina ⇒ tip 0 y total sin cambios', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(validBorrador()));
    const res = await PUT(
      jsonRequest(URL, 'PUT', { items: [{ productId: 'p01', qty: 1 }] }),
      asyncParams({ orderId: 'o1' }),
    );
    const body = await res.json();
    expect(body.cart.tip).toBe(0);
    expect(body.cart.total).toBe(28000 + 4500);
  });

  it('OPTIONS responde 204', async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
  });

  it('aplica promo activa: discount y appliedPromo en cart + promo_id/discount en orders', async () => {
    // Promo: 20% off sobre Pastrami (p01).
    const tables = tablesFor(validBorrador());
    supabaseStub = makeSupabaseStub({
      ...tables,
      promotions: {
        rows: [{
          id: 'pr-pastrami',
          kind: 'product',
          name: '20% Pastrami',
          description: null,
          discount_type: 'percent',
          discount_value: 20,
          min_subtotal: 0,
          config: { product_ids: ['p01'] },
          active: true,
          starts_at: null,
          ends_at: null,
        }],
      },
    });

    const res = await PUT(
      jsonRequest(URL, 'PUT', {
        items: [{ productId: 'p01', qty: 1 }],
        delivery: { address: 'X', zoneId: 'poblado' },
      }),
      asyncParams({ orderId: 'o1' }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cart.subtotal).toBe(28000);
    expect(body.cart.discount).toBe(5600);  // 20% de 28.000
    expect(body.cart.delivery).toBe(4500);  // sin descuento
    expect(body.cart.total).toBe(28000 - 5600 + 4500);
    expect(body.cart.appliedPromo).toMatchObject({
      id: 'pr-pastrami',
      name: '20% Pastrami',
      kind: 'product',
      discountType: 'percent',
      amount: 5600,
    });

    // Persistencia en orders: promo_id + discount + total ya con descuento.
    const [updPayload] = updateCapture.mock.calls[0];
    expect(updPayload.promo_id).toBe('pr-pastrami');
    expect(updPayload.discount).toBe(5600);
    expect(updPayload.total).toBe(26900);
  });

  it('sin promos activas: discount 0, appliedPromo null, promo_id null en orders', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(validBorrador()));
    const res = await PUT(
      jsonRequest(URL, 'PUT', {
        items: [{ productId: 'p01', qty: 1 }],
        delivery: { address: 'X', zoneId: 'poblado' },
      }),
      asyncParams({ orderId: 'o1' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cart.discount).toBe(0);
    expect(body.cart.appliedPromo).toBeNull();
    const [updPayload] = updateCapture.mock.calls[0];
    expect(updPayload.discount).toBe(0);
    expect(updPayload.promo_id).toBeNull();
  });
});

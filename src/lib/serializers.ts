/**
 * Serializadores que mapean el shape de Supabase (snake_case + FKs)
 * al shape camelCase + denormalizado que espera el frontend.
 *
 * Mantenemos el contrato 1:1 con `frontend/src/lib/data.ts` para que los
 * componentes existentes (OrderCard, KanbanColumn, etc.) no se enteren del cambio.
 */

interface OrderRow {
  id: string;
  order_number: number;
  total: number;
  status: string;
  address: string;
  phone: string;
  payment_method: string;
  note: string | null;
  lat: number;
  lng: number;
  created_at: string;
  customer: { id: string; name: string } | { id: string; name: string }[] | null;
  zone: { id: string; name: string } | { id: string; name: string }[] | null;
  items: Array<{
    qty: number;
    product: { name: string } | { name: string }[] | null;
  }> | null;
}

function pickOne<T>(value: T | T[] | null): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export function serializeOrder(row: OrderRow) {
  const customer = pickOne(row.customer);
  const zone = pickOne(row.zone);
  const itemList = (row.items ?? []).map(it => {
    const product = pickOne(it.product);
    return `${it.qty}× ${product?.name ?? '?'}`;
  });
  const minutos = Math.max(
    1,
    Math.floor((Date.now() - new Date(row.created_at).getTime()) / 60000),
  );

  return {
    id: row.id,
    number: row.order_number,
    cliente: customer?.name ?? '',
    items: itemList.join(', '),
    itemList,
    total: row.total,
    zone: zone?.id ?? '',
    zoneName: zone?.name ?? '',
    status: row.status,
    minutos,
    address: row.address,
    phone: row.phone,
    paymentMethod: row.payment_method,
    note: row.note,
    lat: row.lat,
    lng: row.lng,
  };
}

interface ChatRow {
  id: string;
  name: string;
  phone: string;
  last: string;
  time: string;
  unread: number;
  status: string;
  zone_id: string | null;
  last_message_at: string | null;
}

export function serializeChat(row: ChatRow, stats?: { prevOrders: number; avgTicket: number }) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    last: row.last,
    time: row.time,
    unread: row.unread,
    status: row.status,
    zone: row.zone_id ?? '',
    prevOrders: stats?.prevOrders ?? 0,
    avgTicket: stats?.avgTicket ?? 0,
  };
}

interface MessageRow {
  direction: string;
  body: string;
  created_at: string;
}

export function serializeMessage(row: MessageRow) {
  // Tipo del frontend usa `who: 'bot' | 'in' | 'out'` — coincide con direction.
  const time = new Date(row.created_at).toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Bogota',
  });
  return {
    who: row.direction,
    text: row.body,
    time,
  };
}

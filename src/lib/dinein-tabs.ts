// Módulo presencial (dine-in) · lógica de "cuentas de mesa" (tabs).
//
// Una cuenta de mesa es una `order` con order_type='dine_in'. Ciclo de vida:
//   abierta → (ítems por rondas → cocina) → por_cobrar → pagado/cerrada.
// El total se recalcula como SUM(item.qty * price_at_order) + tip (sin domicilio
// ni zona). La cocina se maneja por order_items.kitchen_status.
//
// Estas funciones reciben el cliente Supabase scopeado al usuario (RLS activa)
// y filtran SIEMPRE por company_id (aislamiento multi-empresa en dos capas).

import type { SupabaseClient } from '@supabase/supabase-js';

export class DineInError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = 'DineInError';
  }
}

/** Estados en los que una cuenta sigue "abierta" (admite ítems y pago). */
const OPEN_STATES = ['abierta', 'por_cobrar'];
const ALLOWED_STATUS = ['abierta', 'por_cobrar', 'cerrada'];

const ORDER_COLS =
  'id, order_number, table_id, waiter_id, status, total, tip, order_type, created_at, updated_at';
const ITEM_COLS = 'id, product_id, qty, price_at_order, kitchen_status, note, sent_at';

interface OrderRow {
  id: string;
  order_number: number | null;
  table_id: string | null;
  waiter_id: string | null;
  status: string;
  total: number | null;
  tip: number | null;
  order_type: string;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  id: string;
  product_id: string;
  qty: number;
  price_at_order: number;
  kitchen_status: string;
  note: string | null;
  sent_at: string | null;
}

export interface TabItemInput {
  productId: string;
  qty: number;
  note?: string | null;
}

export interface TabPatch {
  status?: string;
  waiterId?: string | null;
  tip?: number;
}

export interface TabItem {
  id: string;
  productId: string;
  name: string;
  qty: number;
  price: number;
  lineTotal: number;
  kitchenStatus: string;
  note: string | null;
  sentAt: string | null;
}

export interface Tab {
  orderId: string;
  orderNumber: number | null;
  tableId: string | null;
  tableCode: string | null;
  waiterId: string | null;
  status: string;
  subtotal: number;
  tip: number;
  total: number;
  itemCount: number;
  pendingCount: number;
  items: TabItem[];
  createdAt: string;
  updatedAt: string;
}

// -------------------------------------------------------------------------
// Lecturas base
// -------------------------------------------------------------------------
async function fetchOrder(db: SupabaseClient, companyId: string, orderId: string): Promise<OrderRow> {
  const { data, error } = await db
    .from('orders')
    .select(ORDER_COLS)
    .eq('company_id', companyId)
    .eq('id', orderId)
    .eq('order_type', 'dine_in')
    .maybeSingle();
  if (error) throw new DineInError(error.message, 500);
  if (!data) throw new DineInError('Cuenta de mesa no encontrada', 404);
  return data as unknown as OrderRow;
}

async function fetchItems(db: SupabaseClient, companyId: string, orderId: string): Promise<ItemRow[]> {
  const { data, error } = await db
    .from('order_items')
    .select(ITEM_COLS)
    .eq('company_id', companyId)
    .eq('order_id', orderId);
  if (error) throw new DineInError(error.message, 500);
  return (data ?? []) as unknown as ItemRow[];
}

async function tableCodeFor(
  db: SupabaseClient,
  companyId: string,
  tableId: string | null,
): Promise<string | null> {
  if (!tableId) return null;
  const { data } = await db
    .from('dining_tables')
    .select('code')
    .eq('company_id', companyId)
    .eq('id', tableId)
    .maybeSingle();
  return (data as { code?: string } | null)?.code ?? null;
}

async function namesFor(
  db: SupabaseClient,
  companyId: string,
  productIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (productIds.length === 0) return map;
  const { data } = await db
    .from('products')
    .select('id, name')
    .eq('company_id', companyId)
    .in('id', productIds);
  for (const p of (data ?? []) as Array<{ id: string; name: string }>) map.set(p.id, p.name);
  return map;
}

function assemble(
  order: OrderRow,
  items: ItemRow[],
  names: Map<string, string>,
  tableCode: string | null,
): Tab {
  const tabItems: TabItem[] = items.map(it => ({
    id: it.id,
    productId: it.product_id,
    name: names.get(it.product_id) ?? '',
    qty: it.qty,
    price: it.price_at_order,
    lineTotal: it.qty * it.price_at_order,
    kitchenStatus: it.kitchen_status,
    note: it.note,
    sentAt: it.sent_at,
  }));
  const subtotal = tabItems.reduce((s, i) => s + i.lineTotal, 0);
  const tip = order.tip ?? 0;
  return {
    orderId: order.id,
    orderNumber: order.order_number,
    tableId: order.table_id,
    tableCode,
    waiterId: order.waiter_id,
    status: order.status,
    subtotal,
    tip,
    total: subtotal + tip,
    itemCount: tabItems.reduce((s, i) => s + i.qty, 0),
    pendingCount: tabItems.filter(i => i.kitchenStatus === 'pendiente').length,
    items: tabItems,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

async function build(db: SupabaseClient, companyId: string, order: OrderRow): Promise<Tab> {
  const items = await fetchItems(db, companyId, order.id);
  const names = await namesFor(db, companyId, [...new Set(items.map(i => i.product_id))]);
  const tableCode = await tableCodeFor(db, companyId, order.table_id);
  return assemble(order, items, names, tableCode);
}

async function recomputeTotal(db: SupabaseClient, companyId: string, orderId: string, tip: number) {
  const items = await fetchItems(db, companyId, orderId);
  const subtotal = items.reduce((s, i) => s + i.qty * i.price_at_order, 0);
  await db
    .from('orders')
    .update({ total: subtotal + tip, updated_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('id', orderId);
}

// -------------------------------------------------------------------------
// API pública del servicio
// -------------------------------------------------------------------------
export async function getTab(db: SupabaseClient, companyId: string, orderId: string): Promise<Tab> {
  const order = await fetchOrder(db, companyId, orderId);
  return build(db, companyId, order);
}

export async function listOpenTabs(db: SupabaseClient, companyId: string): Promise<Tab[]> {
  const { data, error } = await db
    .from('orders')
    .select(ORDER_COLS)
    .eq('company_id', companyId)
    .eq('order_type', 'dine_in')
    .in('status', OPEN_STATES)
    .order('created_at', { ascending: true });
  if (error) throw new DineInError(error.message, 500);
  const rows = (data ?? []) as unknown as OrderRow[];
  const tabs: Tab[] = [];
  for (const o of rows) tabs.push(await build(db, companyId, o));
  return tabs;
}

/**
 * Abre una cuenta en la mesa (o devuelve la que ya esté abierta — una activa por
 * mesa a la vez). Idempotente frente a doble tap.
 */
export async function openTab(
  db: SupabaseClient,
  companyId: string,
  tableId: string,
  waiterId?: string | null,
): Promise<Tab> {
  const { data: table, error: tErr } = await db
    .from('dining_tables')
    .select('id, archived')
    .eq('company_id', companyId)
    .eq('id', tableId)
    .maybeSingle();
  if (tErr) throw new DineInError(tErr.message, 500);
  if (!table) throw new DineInError('Mesa no encontrada', 404);
  if ((table as { archived: boolean }).archived) throw new DineInError('La mesa está archivada', 409);

  const { data: existing } = await db
    .from('orders')
    .select(ORDER_COLS)
    .eq('company_id', companyId)
    .eq('table_id', tableId)
    .eq('order_type', 'dine_in')
    .in('status', OPEN_STATES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return build(db, companyId, existing as unknown as OrderRow);

  const { data: created, error: cErr } = await db
    .from('orders')
    .insert({
      company_id: companyId,
      table_id: tableId,
      waiter_id: waiterId ?? null,
      order_type: 'dine_in',
      status: 'abierta',
      sales_channel: 'presencial',
      phone: '',
      total: 0,
      tip: 0,
    })
    .select(ORDER_COLS)
    .single();
  if (cErr || !created) throw new DineInError(cErr?.message ?? 'No se pudo abrir la cuenta', 500);
  return build(db, companyId, created as unknown as OrderRow);
}

/** Agrega ítems a la cuenta (una ronda). Los nuevos quedan en kitchen_status='pendiente'. */
export async function addTabItems(
  db: SupabaseClient,
  companyId: string,
  orderId: string,
  inputs: TabItemInput[],
): Promise<Tab> {
  const order = await fetchOrder(db, companyId, orderId);
  if (!OPEN_STATES.includes(order.status)) {
    throw new DineInError('La cuenta ya no admite ítems', 409);
  }
  const clean = inputs.filter(i => i.productId && i.qty > 0);
  if (clean.length === 0) throw new DineInError('Sin ítems para agregar', 400);

  const ids = [...new Set(clean.map(i => i.productId))];
  const { data: prods, error: pErr } = await db
    .from('products')
    .select('id, price, available')
    .eq('company_id', companyId)
    .in('id', ids);
  if (pErr) throw new DineInError(pErr.message, 500);

  const priceMap = new Map<string, number>();
  const availMap = new Map<string, boolean>();
  for (const p of (prods ?? []) as Array<{ id: string; price: number; available: boolean }>) {
    priceMap.set(p.id, p.price);
    availMap.set(p.id, p.available);
  }

  const rows = clean.map(it => {
    const price = priceMap.get(it.productId);
    if (price === undefined) throw new DineInError(`Producto no existe: ${it.productId}`, 400);
    if (availMap.get(it.productId) === false) throw new DineInError('Un producto no está disponible', 409);
    return {
      order_id: orderId,
      company_id: companyId,
      product_id: it.productId,
      qty: it.qty,
      price_at_order: price,
      kitchen_status: 'pendiente',
      note: it.note ?? null,
    };
  });

  const { error: insErr } = await db.from('order_items').insert(rows);
  if (insErr) throw new DineInError(insErr.message, 500);

  await recomputeTotal(db, companyId, orderId, order.tip ?? 0);
  return getTab(db, companyId, orderId);
}

/** Manda a cocina los ítems pendientes de la cuenta (una comanda). */
export async function sendTabToKitchen(
  db: SupabaseClient,
  companyId: string,
  orderId: string,
): Promise<Tab> {
  const order = await fetchOrder(db, companyId, orderId);
  if (!OPEN_STATES.includes(order.status)) {
    throw new DineInError('La cuenta ya no admite envíos a cocina', 409);
  }
  const { error } = await db
    .from('order_items')
    .update({ kitchen_status: 'en_cocina', sent_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('order_id', orderId)
    .eq('kitchen_status', 'pendiente');
  if (error) throw new DineInError(error.message, 500);
  return getTab(db, companyId, orderId);
}

/** Cambia estado (por_cobrar/cerrada), mesero asignado o propina de la cuenta. */
export async function updateTab(
  db: SupabaseClient,
  companyId: string,
  orderId: string,
  patch: TabPatch,
): Promise<Tab> {
  await fetchOrder(db, companyId, orderId);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (patch.status !== undefined) {
    if (!ALLOWED_STATUS.includes(patch.status)) throw new DineInError('Estado inválido', 400);
    update.status = patch.status;
  }
  if (patch.waiterId !== undefined) update.waiter_id = patch.waiterId;
  if (patch.tip !== undefined) {
    if (patch.tip < 0) throw new DineInError('Propina inválida', 400);
    update.tip = patch.tip;
    const items = await fetchItems(db, companyId, orderId);
    const subtotal = items.reduce((s, i) => s + i.qty * i.price_at_order, 0);
    update.total = subtotal + patch.tip;
  }

  if (Object.keys(update).length === 1) throw new DineInError('Nada que actualizar', 400);

  const { error } = await db
    .from('orders')
    .update(update)
    .eq('company_id', companyId)
    .eq('id', orderId)
    .eq('order_type', 'dine_in');
  if (error) throw new DineInError(error.message, 500);
  return getTab(db, companyId, orderId);
}

/** Mapea un error del servicio a una Response JSON con el status adecuado. */
export function tabErrorResponse(err: unknown): Response {
  if (err instanceof DineInError) {
    return Response.json({ ok: false, error: err.message }, { status: err.status });
  }
  console.error('[dinein] error', err);
  return Response.json({ ok: false, error: 'Error en la cuenta de mesa' }, { status: 500 });
}

// Módulo presencial (dine-in) · SPLIT de pago de una cuenta de mesa.
//
// La cuenta (order dine_in) tiene un `total`. Cada "porción" es una fila en
// `order_payments`:
//   - method 'wompi'            → se paga online; el webhook la liquida.
//   - method 'efectivo'/'datafono' → la registra el mesero, queda 'pagado' de una.
//
// La cuenta se cierra (status 'pagado') cuando SUM(amount de porciones 'pagado')
// >= total. El cierre es condicional (solo desde abierta/por_cobrar) para tolerar
// dos porciones liquidándose casi a la vez.
//
// Cada porción Wompi lleva un `wompi_reference` con prefijo `sp_` para que el
// webhook la distinga de una orden normal (cuyo reference es el orderId).

import type { SupabaseClient } from '@supabase/supabase-js';
import { DineInError } from './dinein-tabs';

const SHARE_REF_PREFIX = 'sp_';
const OPEN_STATES = ['abierta', 'por_cobrar'];
const SHARE_COLS =
  'id, order_id, company_id, amount, status, method, wompi_reference, wompi_tx_id, label, paid_at, created_at';

export function isShareReference(ref: string): boolean {
  return ref.startsWith(SHARE_REF_PREFIX);
}

function newShareReference(): string {
  return `${SHARE_REF_PREFIX}${crypto.randomUUID().replace(/-/g, '')}`;
}

interface OrderRow {
  id: string;
  company_id: string;
  total: number | null;
  status: string;
  order_type: string;
}

interface ShareRow {
  id: string;
  order_id: string;
  company_id: string;
  amount: number;
  status: string;
  method: string;
  wompi_reference: string | null;
  wompi_tx_id: string | null;
  label: string | null;
  paid_at: string | null;
  created_at: string;
}

export interface SplitShare {
  id: string;
  amount: number;
  status: string;
  method: string;
  label: string | null;
  paidAt: string | null;
}

export interface SplitView {
  orderId: string;
  status: string;
  total: number;
  collected: number;
  remaining: number;
  fullyPaid: boolean;
  shares: SplitShare[];
}

export interface SettleResult {
  applied: boolean;
  reason?: string;
  tabClosed?: boolean;
}

function serializeShare(r: ShareRow): SplitShare {
  return { id: r.id, amount: r.amount, status: r.status, method: r.method, label: r.label, paidAt: r.paid_at };
}

async function loadDineInOrder(db: SupabaseClient, companyId: string, orderId: string): Promise<OrderRow> {
  const { data, error } = await db
    .from('orders')
    .select('id, company_id, total, status, order_type')
    .eq('company_id', companyId)
    .eq('id', orderId)
    .eq('order_type', 'dine_in')
    .maybeSingle();
  if (error) throw new DineInError(error.message, 500);
  if (!data) throw new DineInError('Cuenta de mesa no encontrada', 404);
  return data as unknown as OrderRow;
}

async function fetchShares(db: SupabaseClient, companyId: string, orderId: string): Promise<ShareRow[]> {
  const { data, error } = await db
    .from('order_payments')
    .select(SHARE_COLS)
    .eq('company_id', companyId)
    .eq('order_id', orderId)
    .order('created_at', { ascending: true });
  if (error) throw new DineInError(error.message, 500);
  return (data ?? []) as unknown as ShareRow[];
}

function collectedFrom(shares: ShareRow[]): number {
  return shares.filter(s => s.status === 'pagado').reduce((sum, r) => sum + r.amount, 0);
}

export async function getSplitView(db: SupabaseClient, companyId: string, orderId: string): Promise<SplitView> {
  const order = await loadDineInOrder(db, companyId, orderId);
  const shares = await fetchShares(db, companyId, orderId);
  const total = order.total ?? 0;
  const collected = collectedFrom(shares);
  return {
    orderId,
    status: order.status,
    total,
    collected,
    remaining: Math.max(0, total - collected),
    fullyPaid: total > 0 && collected >= total,
    shares: shares.map(serializeShare),
  };
}

/** Cierra la cuenta (status 'pagado') si lo recaudado alcanza el total. Idempotente. */
async function closeIfSettled(
  db: SupabaseClient,
  companyId: string,
  orderId: string,
  total: number,
): Promise<boolean> {
  const shares = await fetchShares(db, companyId, orderId);
  if (total <= 0 || collectedFrom(shares) < total) return false;
  const { error } = await db
    .from('orders')
    .update({ status: 'pagado', updated_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('id', orderId)
    .in('status', OPEN_STATES);
  if (error) throw new DineInError(error.message, 500);
  return true;
}

/**
 * Crea una porción para pago Wompi (status 'procesando') con reference propio.
 * Valida que el monto no exceda lo que falta por cobrar.
 */
export async function createWompiShare(
  db: SupabaseClient,
  companyId: string,
  orderId: string,
  amount: number,
  label?: string | null,
): Promise<{ shareId: string; reference: string; amount: number }> {
  const order = await loadDineInOrder(db, companyId, orderId);
  if (!OPEN_STATES.includes(order.status)) throw new DineInError('La cuenta ya está cerrada', 409);
  if (!Number.isInteger(amount) || amount <= 0) throw new DineInError('Monto inválido', 400);

  const total = order.total ?? 0;
  const remaining = total - collectedFrom(await fetchShares(db, companyId, orderId));
  if (remaining <= 0) throw new DineInError('La cuenta ya está saldada', 409);
  if (amount > remaining) throw new DineInError(`El monto excede lo que falta por cobrar (${remaining})`, 400);

  const reference = newShareReference();
  const { data, error } = await db
    .from('order_payments')
    .insert({
      company_id: companyId,
      order_id: orderId,
      amount,
      status: 'procesando',
      method: 'wompi',
      wompi_reference: reference,
      label: label ?? null,
    })
    .select('id')
    .single();
  if (error || !data) throw new DineInError(error?.message ?? 'No se pudo crear la porción', 500);
  return { shareId: (data as { id: string }).id, reference, amount };
}

/** Registra un pago presencial (efectivo/datáfono): queda 'pagado' al instante. */
export async function registerCashShare(
  db: SupabaseClient,
  companyId: string,
  orderId: string,
  amount: number,
  method: string,
  label?: string | null,
): Promise<SplitView> {
  const order = await loadDineInOrder(db, companyId, orderId);
  if (!OPEN_STATES.includes(order.status)) throw new DineInError('La cuenta ya está cerrada', 409);
  if (!['efectivo', 'datafono'].includes(method)) throw new DineInError('Método inválido', 400);
  if (!Number.isInteger(amount) || amount <= 0) throw new DineInError('Monto inválido', 400);

  const total = order.total ?? 0;
  const remaining = total - collectedFrom(await fetchShares(db, companyId, orderId));
  if (amount > remaining) throw new DineInError(`El monto excede lo que falta por cobrar (${remaining})`, 400);

  const { error } = await db.from('order_payments').insert({
    company_id: companyId,
    order_id: orderId,
    amount,
    status: 'pagado',
    method,
    label: label ?? null,
    paid_at: new Date().toISOString(),
  });
  if (error) throw new DineInError(error.message, 500);

  await closeIfSettled(db, companyId, orderId, total);
  return getSplitView(db, companyId, orderId);
}

// -------------------------------------------------------------------------
// Liquidación desde el webhook Wompi
// -------------------------------------------------------------------------
export interface ShareByRef {
  id: string;
  order_id: string;
  company_id: string;
  amount: number;
  status: string;
  wompi_tx_id: string | null;
}

export async function findShareByReference(
  db: SupabaseClient,
  companyId: string,
  reference: string,
): Promise<ShareByRef | null> {
  const { data } = await db
    .from('order_payments')
    .select('id, order_id, company_id, amount, status, wompi_tx_id')
    .eq('company_id', companyId)
    .eq('wompi_reference', reference)
    .maybeSingle();
  return (data as unknown as ShareByRef) ?? null;
}

/** Liquida una porción aprobada. Idempotente (solo desde 'procesando'). */
export async function settleShareApproved(
  db: SupabaseClient,
  companyId: string,
  share: ShareByRef,
  txId: string,
  amountInCents: number,
): Promise<SettleResult> {
  if (share.status === 'pagado') return { applied: false, reason: 'porción ya pagada' };
  if (amountInCents !== share.amount * 100) {
    return { applied: false, reason: `monto (${amountInCents}) != porción (${share.amount * 100})` };
  }
  const { error } = await db
    .from('order_payments')
    .update({
      status: 'pagado',
      wompi_tx_id: txId,
      wompi_status_message: null,
      paid_at: new Date().toISOString(),
    })
    .eq('company_id', companyId)
    .eq('id', share.id)
    .eq('status', 'procesando');
  if (error) throw new DineInError(error.message, 500);

  const { data: ord } = await db
    .from('orders')
    .select('total')
    .eq('company_id', companyId)
    .eq('id', share.order_id)
    .maybeSingle();
  const total = (ord as { total: number | null } | null)?.total ?? 0;
  const tabClosed = await closeIfSettled(db, companyId, share.order_id, total);
  return { applied: true, tabClosed };
}

/** Marca una porción como fallida (declined/void/error). */
export async function settleShareFailed(
  db: SupabaseClient,
  companyId: string,
  share: ShareByRef,
  txId: string,
  statusMessage: string,
): Promise<SettleResult> {
  if (share.status === 'pagado') return { applied: false, reason: 'porción ya pagada' };
  const { error } = await db
    .from('order_payments')
    .update({ status: 'fallido', wompi_tx_id: txId, wompi_status_message: statusMessage })
    .eq('company_id', companyId)
    .eq('id', share.id);
  if (error) throw new DineInError(error.message, 500);
  return { applied: true };
}

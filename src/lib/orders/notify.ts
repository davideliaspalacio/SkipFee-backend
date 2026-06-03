import type { SupabaseClient } from '@supabase/supabase-js';
import { sendText } from '@/lib/kapso/client';
import { recordMessage } from '@/lib/messaging';
import { getMessage } from '@/lib/bot/messages/catalog';
import { render } from '@/lib/bot/messages/render';

/**
 * Notificación de seguimiento por cambio de estado del pedido (post-pago).
 *
 * Generaliza el patrón `route_notified_at` (migración 0005, que solo cubría
 * 'ruta') a TODOS los hitos relevantes usando una columna `notified_statuses`
 * (text[], migración 0010). Es **idempotente**: si el pedido vuelve atrás en el
 * kanban y re-avanza, no se reenvía el mensaje de un estado ya notificado.
 *
 * El estado 'pagado' lo notifica primariamente el webhook de Wompi ("pago
 * recibido"); acá se cubre también por si una operaria mueve la tarjeta a
 * 'pagado' a mano. 'empacado' no notifica (es interno de cocina).
 */

export const NOTIFIABLE_STATUSES = ['pagado', 'cocina', 'ruta', 'entregado'] as const;
export type NotifiableStatus = (typeof NOTIFIABLE_STATUSES)[number];

function isNotifiable(status: string): status is NotifiableStatus {
  return (NOTIFIABLE_STATUSES as readonly string[]).includes(status);
}

interface NotifyOrder {
  id: string;
  phone: string;
  notified_statuses?: string[] | null;
  customer?: { name?: string } | { name?: string }[] | null;
}

function firstNameOf(order: NotifyOrder): string {
  const c = Array.isArray(order.customer) ? order.customer[0] : order.customer;
  return (c?.name ?? '').split(' ')[0] || '';
}

/**
 * Mensaje por estado, editable desde la UI (`notif.*`). `firstName` puede venir
 * vacío. `{{saludo}}` = "Hola {nombre}" o "Hola" si no hay nombre.
 */
async function messageFor(status: NotifiableStatus, firstName: string): Promise<string> {
  const saludo = firstName ? `Hola ${firstName}` : 'Hola';
  const m = await getMessage(`notif.${status}`);
  return render(m.body, { saludo, nombre: firstName });
}

export interface NotifyResult {
  sent: boolean;
  skipped?: 'not-notifiable' | 'already-notified';
  error?: string;
}

/**
 * Envía (si corresponde) el WhatsApp de seguimiento por la transición a
 * `newStatus` y marca el estado como notificado. No lanza: cualquier fallo de
 * envío se devuelve en `error` para que el caller no rompa la respuesta (el
 * cambio de estado en BD ya ocurrió).
 */
export async function notifyOrderStatus(opts: {
  sb: SupabaseClient;
  order: NotifyOrder;
  newStatus: string;
}): Promise<NotifyResult> {
  const { sb, order, newStatus } = opts;

  if (!isNotifiable(newStatus)) return { sent: false, skipped: 'not-notifiable' };

  const already = order.notified_statuses ?? [];
  if (already.includes(newStatus)) return { sent: false, skipped: 'already-notified' };

  const body = await messageFor(newStatus, firstNameOf(order));

  try {
    const result = await sendText(order.phone, body);
    const wamid = result?.messages?.[0]?.id ?? null;
    await recordMessage({ phone: order.phone, direction: 'bot', body, kapsoMessageId: wamid });

    const { error } = await sb
      .from('orders')
      .update({ notified_statuses: [...already, newStatus] })
      .eq('id', order.id);
    if (error) {
      // El mensaje ya salió; loguear pero no fallar (podría re-notificar si se
      // revisita el estado, pero es mejor eso que romper el cambio de estado).
      console.error('[notifyOrderStatus] mark notified error', error);
    }
    return { sent: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[notifyOrderStatus] send error', err);
    return { sent: false, error: msg };
  }
}

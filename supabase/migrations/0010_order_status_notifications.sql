-- Seguimiento post-pago generalizado.
--
-- Generaliza `route_notified_at` (0005, solo cubría 'ruta') a TODOS los hitos
-- notificables del pedido (pagado/cocina/ruta/entregado). Guardamos qué estados
-- ya se notificaron en un array para que el seguimiento sea idempotente aunque
-- la operaria mueva la tarjeta hacia atrás y la vuelva a avanzar.
--
-- Lo consume `notifyOrderStatus` (src/lib/orders/notify.ts), invocado desde
-- PATCH /api/orders/:id/status.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS notified_statuses text[] NOT NULL DEFAULT '{}';

-- Backfill: a los pedidos que YA pasaron por la línea de producción los marcamos
-- como "todo notificado" para no spamear seguimiento en el primer deploy. Los
-- pedidos nuevos arrancan con '{}' y se van marcando a medida que avanzan.
UPDATE orders
   SET notified_statuses = ARRAY['pagado', 'cocina', 'ruta', 'entregado']
 WHERE status IN ('pagado', 'cocina', 'empacado', 'ruta', 'entregado');

-- `route_notified_at` queda en la tabla por compatibilidad (no se borra), pero el
-- código ya no lo usa: la idempotencia vive en `notified_statuses`.

-- Marca cuándo se notificó al cliente que el pedido va en camino.
-- Permite hacer idempotente el WhatsApp "tu pedido va en camino 🛵" si el
-- pedido vuelve a 'ruta' después de un reverso.

ALTER TABLE orders ADD COLUMN route_notified_at timestamptz;

-- Backfill: pedidos que ya pasaron por 'ruta' se consideran notificados
-- para que un reverso + re-avance no dispare un segundo mensaje.
UPDATE orders
   SET route_notified_at = updated_at
 WHERE status IN ('ruta', 'entregado');

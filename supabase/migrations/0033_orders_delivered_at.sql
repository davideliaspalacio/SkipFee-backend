-- Bros and Subs · momento de entrega del pedido
--
-- Hasta ahora no guardábamos CUÁNDO se entregó un pedido: `notified_statuses` no
-- tiene timestamps y `updated_at` cambia en cada movimiento del kanban. Lo
-- necesitamos para dos flujos de post-venta:
--   · la encuesta "califícanos" diferida (cron survey-dispatch, N min después
--     de la entrega — antes se mandaba síncrono al entregar).
--   · ofrecer "hacer otro pedido / hablar con humano" si el cliente vuelve a
--     escribir dentro de 1 h de la entrega.
--
-- Se setea una sola vez, al ENTRAR por primera vez a 'entregado'
-- (app/api/orders/[id]/status). Pedidos ya entregados quedan en NULL: las
-- ventanas usan comparaciones >=/<= que los excluyen solas (no se rellena).

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

-- El cron de encuesta busca entregados dentro de una ventana de tiempo; el
-- index parcial cubre solo los 'entregado' (set chico vs. todo el histórico).
CREATE INDEX IF NOT EXISTS orders_delivered_at_idx
  ON orders (delivered_at)
  WHERE status = 'entregado';

-- Número de pedido legible para mostrar al usuario (#1, #2, ...).
-- El id sigue siendo el UUID (PK + FKs); order_number es solo para UI.
--
-- Backfill: rows existentes se numeran por created_at ascendente para que
-- los pedidos más viejos tengan los números más bajos.

ALTER TABLE orders ADD COLUMN order_number bigint;

UPDATE orders o
   SET order_number = sub.n
  FROM (
    SELECT id, row_number() OVER (ORDER BY created_at ASC, id ASC) AS n
      FROM orders
  ) AS sub
 WHERE o.id = sub.id;

-- Secuencia para auto-incrementar nuevos pedidos. Empieza después del max actual.
CREATE SEQUENCE orders_order_number_seq AS bigint OWNED BY orders.order_number;

SELECT setval(
  'orders_order_number_seq',
  COALESCE((SELECT MAX(order_number) FROM orders), 0),
  true
);

ALTER TABLE orders ALTER COLUMN order_number SET DEFAULT nextval('orders_order_number_seq');
ALTER TABLE orders ALTER COLUMN order_number SET NOT NULL;
ALTER TABLE orders ADD CONSTRAINT orders_order_number_unique UNIQUE (order_number);

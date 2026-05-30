-- Contador secuencial visible para humanos (001, 002, 003…) sin tocar
-- el UUID interno (que sigue siendo PK + FK). Los pedidos existentes
-- reciben order_number automáticamente por la secuencia de BIGSERIAL.

ALTER TABLE orders ADD COLUMN order_number BIGSERIAL NOT NULL;
ALTER TABLE orders ADD CONSTRAINT orders_order_number_unique UNIQUE (order_number);

-- Comentario para documentar
COMMENT ON COLUMN orders.order_number IS
  'Contador autoincremental visible para humanos (#001, #002…). El id sigue siendo el UUID para FKs y URLs internas.';

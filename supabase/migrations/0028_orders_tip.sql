-- Propina (checkout web): el cliente puede agregar 10% (sobre el subtotal) o un
-- monto custom. `tip` es el monto en COP (ya sumado a `orders.total`). `tip_percent`
-- recuerda el % elegido (p. ej. 10) para mostrar el botón correcto al recargar;
-- null = monto custom o sin propina.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tip         integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tip_percent integer;

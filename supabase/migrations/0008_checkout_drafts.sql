-- Bros and Subs · Checkout web — borradores de pedido (Opción A)
--
-- Modela el "carrito reservado" de la tienda web como una orden en estado
-- `borrador` sobre la MISMA tabla `orders`. El `orderId` (uuid) ES la orden y
-- funciona como token secreto. La orden nace casi vacía (solo phone + expires_at)
-- y se va llenando vía /api/checkout/:orderId/cart hasta que el cliente paga.
--
-- Decisiones (ver CONTRACT_CHECKOUT.md / PLAN_CHECKOUT_WEB.md):
--  - Estados nuevos: `borrador` (editable, no entra al kanban) y `expirado`
--    (borrador que venció sin pagar; lo limpia un cron).
--  - Vencimiento: expires_at = now() + TTL (default 30 min, lo pone el backend).
--  - Columnas que aún no existen en un borrador pasan a NULLABLE; el checkout
--    las completa y valida que estén llenas antes de pagar.
--
-- IMPORTANTE (Postgres): NO se puede agregar un valor a un enum y usarlo en la
-- misma transacción. Por eso los `ALTER TYPE ... ADD VALUE` van primero, con su
-- propio COMMIT, antes de cualquier statement que referencie los nuevos labels.
-- Los `ADD VALUE IF NOT EXISTS` hacen la migración idempotente/reejecutable.

-- =========================================================================
-- 1. Nuevos valores del enum order_status (en su propia transacción)
-- =========================================================================

ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'borrador';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'expirado';

COMMIT;

-- =========================================================================
-- 2. Columnas nullable + expires_at (nueva transacción, ya ven los labels)
-- =========================================================================

BEGIN;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- En un borrador todavía no conocemos estos datos: hacerlos NULLABLE.
-- (En el checkout se llenan y se valida completitud antes de pagar.)
ALTER TABLE orders ALTER COLUMN customer_id    DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN total          DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN zone_id        DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN address        DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN payment_method DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN lat            DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN lng            DROP NOT NULL;

-- Índice parcial: el cron de expiración solo escanea borradores con vencimiento.
CREATE INDEX IF NOT EXISTS orders_expires_at_idx
  ON orders(expires_at)
  WHERE status = 'borrador';

COMMIT;

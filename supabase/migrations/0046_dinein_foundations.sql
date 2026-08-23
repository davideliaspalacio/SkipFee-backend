-- SkipFee · Fundamentos de ventas presenciales (dine-in): mesas, meseros y split
-- =========================================================================
-- Módulo ADITIVO sobre el sistema de pedidos existente. NO cambia el flujo
-- online (delivery/tienda). Habilita:
--   · Mesas (dining_tables) con QR para autoservicio.
--   · Meseros (waiters) como staff asignable a una cuenta (patrón de cooks/0019).
--   · La cuenta de una mesa = una `order` con order_type='dine_in' + table_id.
--   · Split de pago: cada porción es un `order_payments` (una transacción Wompi
--     por porción); efectivo/datáfono también se registran ahí.
--   · Canal `presencial` en sales_channels (omnicanal: online vs presencial).
--
-- El kanban de delivery NO se toca: filtrará order_type='delivery'. El dine-in
-- vive en una vista "Salón" aparte. La cocina del dine-in se maneja por
-- order_items.kitchen_status (rondas/comandas), no por cook_id.
--
-- Depende de 0045 (valores de order_status: abierta/por_cobrar/cerrada).
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1) Mesas (dining_tables). `qr_token` es el token no adivinable del QR.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dining_tables (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code        text NOT NULL,
  label       text,
  area        text,
  seats       integer NOT NULL DEFAULT 4,
  qr_token    text NOT NULL DEFAULT gen_random_uuid()::text,
  is_active   boolean NOT NULL DEFAULT true,
  archived    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dining_tables_company_code_unique UNIQUE (company_id, code)
);

CREATE UNIQUE INDEX IF NOT EXISTS dining_tables_qr_token_idx ON dining_tables(qr_token);
CREATE INDEX IF NOT EXISTS dining_tables_company_active_idx
  ON dining_tables(company_id) WHERE archived = false;

DROP TRIGGER IF EXISTS dining_tables_set_updated_at ON dining_tables;
CREATE TRIGGER dining_tables_set_updated_at
  BEFORE UPDATE ON dining_tables
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -------------------------------------------------------------------------
-- 2) Meseros (waiters). Soft-delete con `archived` (igual que cooks/0019).
--    `pin`/`user_id` opcionales para el login del rol mesero (fase posterior).
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS waiters (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  phone       text,
  pin         text,
  user_id     uuid,
  archived    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS waiters_company_active_idx
  ON waiters(company_id) WHERE archived = false;

DROP TRIGGER IF EXISTS waiters_set_updated_at ON waiters;
CREATE TRIGGER waiters_set_updated_at
  BEFORE UPDATE ON waiters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -------------------------------------------------------------------------
-- 3) Metadatos dine-in en pedidos.
--    order_type discrimina el pedido; el kanban delivery filtra por él.
-- -------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type text NOT NULL DEFAULT 'delivery';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_id   text REFERENCES dining_tables(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS waiter_id  text REFERENCES waiters(id);

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
DO $c$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_order_type_check
    CHECK (order_type IN ('delivery', 'pickup', 'dine_in'));
EXCEPTION WHEN duplicate_object THEN NULL;
          WHEN duplicate_table  THEN NULL;
END $c$;
CREATE INDEX IF NOT EXISTS orders_company_table_idx
  ON orders(company_id, table_id) WHERE table_id IS NOT NULL;

-- Cuentas de mesa activas (para resolver "la mesa X ya tiene tab abierto").
CREATE INDEX IF NOT EXISTS orders_open_tabs_idx
  ON orders(company_id, table_id)
  WHERE order_type = 'dine_in' AND status IN ('abierta', 'por_cobrar');

-- -------------------------------------------------------------------------
-- 4) Ítems: estado de cocina (rondas/comandas) + nota por línea.
--    Los pedidos delivery ignoran kitchen_status (default 'pendiente').
-- -------------------------------------------------------------------------
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS kitchen_status text NOT NULL DEFAULT 'pendiente';
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS sent_at        timestamptz;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS note           text;

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_kitchen_status_check;
DO $c$ BEGIN
  ALTER TABLE order_items ADD CONSTRAINT order_items_kitchen_status_check
    CHECK (kitchen_status IN ('pendiente', 'en_cocina', 'listo', 'servido'));
EXCEPTION WHEN duplicate_object THEN NULL;
          WHEN duplicate_table  THEN NULL;
END $c$;
CREATE INDEX IF NOT EXISTS order_items_kitchen_idx
  ON order_items(company_id, kitchen_status)
  WHERE kitchen_status IN ('pendiente', 'en_cocina');

-- -------------------------------------------------------------------------
-- 5) Split de pago: porciones de una cuenta (order_payments).
--    Cada porción `wompi` = una transacción independiente (reference/firma
--    propios). efectivo/datáfono se registran con method != 'wompi'.
--    La cuenta se cierra cuando SUM(amount WHERE status='pagado') >= orders.total.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id             text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  label                text,
  amount               integer NOT NULL,
  status               text NOT NULL DEFAULT 'pendiente',
  method               text NOT NULL DEFAULT 'wompi',
  wompi_reference      text,
  wompi_tx_id          text,
  wompi_status_message text,
  paid_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_payments_amount_positive CHECK (amount > 0),
  CONSTRAINT order_payments_status_check CHECK (
    status IN ('pendiente', 'procesando', 'pagado', 'fallido', 'anulado')
  ),
  CONSTRAINT order_payments_method_check CHECK (method IN ('wompi', 'efectivo', 'datafono'))
);

CREATE INDEX IF NOT EXISTS order_payments_order_idx ON order_payments(order_id);
CREATE INDEX IF NOT EXISTS order_payments_company_idx ON order_payments(company_id, created_at DESC);
-- reference/tx únicos: evitan doble procesamiento del webhook (igual que orders.wompi_tx_id).
CREATE UNIQUE INDEX IF NOT EXISTS order_payments_wompi_reference_idx
  ON order_payments(wompi_reference) WHERE wompi_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS order_payments_wompi_tx_idx
  ON order_payments(wompi_tx_id) WHERE wompi_tx_id IS NOT NULL;

DROP TRIGGER IF EXISTS order_payments_set_updated_at ON order_payments;
CREATE TRIGGER order_payments_set_updated_at
  BEFORE UPDATE ON order_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -------------------------------------------------------------------------
-- 6) RLS tenant_all. La escritura real es vía service_role (bypassa RLS); la
--    tienda pública lee/paga a través del backend con service_role.
-- -------------------------------------------------------------------------
ALTER TABLE dining_tables  ENABLE ROW LEVEL SECURITY;
ALTER TABLE waiters        ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_all ON dining_tables;
CREATE POLICY tenant_all ON dining_tables
  FOR ALL TO authenticated
  USING (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

DROP POLICY IF EXISTS tenant_all ON waiters;
CREATE POLICY tenant_all ON waiters
  FOR ALL TO authenticated
  USING (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

DROP POLICY IF EXISTS tenant_all ON order_payments;
CREATE POLICY tenant_all ON order_payments
  FOR ALL TO authenticated
  USING (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

-- -------------------------------------------------------------------------
-- 7) Canal `presencial` en sales_channels (amplía el CHECK de 0043).
--    settings.split = defaults configurables por negocio (mínimo por porción,
--    tope de divisiones, quién asume el fee, recargo fijo opcional).
-- -------------------------------------------------------------------------
ALTER TABLE sales_channels DROP CONSTRAINT IF EXISTS sales_channels_provider_check;
DO $c$ BEGIN
  ALTER TABLE sales_channels ADD CONSTRAINT sales_channels_provider_check CHECK (
    provider IN ('whatsapp', 'storefront', 'rappi', 'didi', 'ubereats', 'manual', 'presencial')
  );
EXCEPTION WHEN duplicate_object THEN NULL;
          WHEN duplicate_table  THEN NULL;
END $c$;
INSERT INTO sales_channels (
  company_id, provider, name, kind, mode, status,
  delivery_mode, commission_rate_bps, credentials_status, settings
)
SELECT
  c.id, 'presencial', 'Presencial / Mesa', 'pos', 'live', 'live_connected',
  'dine_in', 0, 'configured',
  '{"split":{"minShare":15000,"maxParts":10,"feeOwner":"restaurante","fixedSurcharge":0},"dineIn":{"selfOrderQR":true}}'::jsonb
FROM companies c
ON CONFLICT (company_id, provider) DO NOTHING;

-- -------------------------------------------------------------------------
-- 8) Seed de mesas de ejemplo (M1..M6 por empresa; idempotente).
-- -------------------------------------------------------------------------
INSERT INTO dining_tables (company_id, code, seats)
SELECT c.id, 'M' || g, CASE WHEN g <= 2 THEN 2 ELSE 4 END
FROM companies c
CROSS JOIN generate_series(1, 6) AS g
ON CONFLICT (company_id, code) DO NOTHING;

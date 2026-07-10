-- SkipFee · Canales omnicanal y simuladores Rappi/DiDi
-- =========================================================================
-- Prepara el backend para recibir pedidos de canales externos sin acoplar el
-- kanban a un proveedor específico. P0 usa modo `simulated`; `live` queda para
-- cuando existan credenciales/documentación privada del partner.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1) Metadatos de origen en pedidos normalizados
-- -------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sales_channel text NOT NULL DEFAULT 'whatsapp';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_order_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_store_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS channel_status text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS channel_delivery_method text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS channel_commission integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS channel_discount integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS channel_payload jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS orders_company_sales_channel_idx
  ON orders(company_id, sales_channel, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS orders_company_channel_external_idx
  ON orders(company_id, sales_channel, external_order_id)
  WHERE external_order_id IS NOT NULL;

-- -------------------------------------------------------------------------
-- 2) Configuración de canales por empresa
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_channels (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider            text NOT NULL,
  name                text NOT NULL,
  kind                text NOT NULL,
  mode                text NOT NULL DEFAULT 'simulated',
  status              text NOT NULL DEFAULT 'not_configured',
  delivery_mode       text NOT NULL DEFAULT 'own_delivery',
  commission_rate_bps integer NOT NULL DEFAULT 0,
  external_store_id   text,
  credentials_status  text NOT NULL DEFAULT 'missing',
  settings            jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_event_at       timestamptz,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_channels_company_provider_unique UNIQUE (company_id, provider),
  CONSTRAINT sales_channels_provider_check CHECK (
    provider IN ('whatsapp', 'storefront', 'rappi', 'didi', 'ubereats', 'manual')
  ),
  CONSTRAINT sales_channels_kind_check CHECK (kind IN ('direct', 'marketplace', 'pos')),
  CONSTRAINT sales_channels_mode_check CHECK (mode IN ('none', 'simulated', 'live')),
  CONSTRAINT sales_channels_status_check CHECK (
    status IN (
      'not_configured',
      'simulated_ready',
      'live_pending_credentials',
      'live_connected',
      'degraded',
      'paused'
    )
  )
);

DROP TRIGGER IF EXISTS sales_channels_set_updated_at ON sales_channels;
CREATE TRIGGER sales_channels_set_updated_at
  BEFORE UPDATE ON sales_channels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS sales_channels_company_provider_idx
  ON sales_channels(company_id, provider);

-- -------------------------------------------------------------------------
-- 3) Eventos recibidos/simulados
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel_id         uuid REFERENCES sales_channels(id) ON DELETE SET NULL,
  provider           text NOT NULL,
  external_event_id  text NOT NULL,
  event_type         text NOT NULL,
  external_order_id  text,
  payload            jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'processed',
  processed_order_id text REFERENCES orders(id) ON DELETE SET NULL,
  error              text,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  CONSTRAINT marketplace_events_company_provider_event_unique
    UNIQUE (company_id, provider, external_event_id),
  CONSTRAINT marketplace_events_provider_check CHECK (provider IN ('rappi', 'didi', 'ubereats')),
  CONSTRAINT marketplace_events_status_check CHECK (status IN ('received', 'processed', 'failed', 'ignored'))
);

CREATE INDEX IF NOT EXISTS marketplace_events_company_provider_idx
  ON marketplace_events(company_id, provider, received_at DESC);

-- -------------------------------------------------------------------------
-- 4) Mapeo catálogo interno ↔ catálogo externo
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channel_product_mappings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider              text NOT NULL,
  product_id            text REFERENCES products(id) ON DELETE SET NULL,
  external_product_id   text NOT NULL,
  external_product_name text NOT NULL,
  price_override        integer,
  is_available          boolean NOT NULL DEFAULT true,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_product_mappings_company_provider_external_unique
    UNIQUE (company_id, provider, external_product_id),
  CONSTRAINT channel_product_mappings_provider_check CHECK (provider IN ('rappi', 'didi', 'ubereats'))
);

DROP TRIGGER IF EXISTS channel_product_mappings_set_updated_at ON channel_product_mappings;
CREATE TRIGGER channel_product_mappings_set_updated_at
  BEFORE UPDATE ON channel_product_mappings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS channel_product_mappings_company_provider_idx
  ON channel_product_mappings(company_id, provider);

-- -------------------------------------------------------------------------
-- 5) RLS tenant_all
-- -------------------------------------------------------------------------
ALTER TABLE sales_channels           ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_product_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_all ON sales_channels;
CREATE POLICY tenant_all ON sales_channels
  FOR ALL TO authenticated
  USING (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

DROP POLICY IF EXISTS tenant_all ON marketplace_events;
CREATE POLICY tenant_all ON marketplace_events
  FOR ALL TO authenticated
  USING (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

DROP POLICY IF EXISTS tenant_all ON channel_product_mappings;
CREATE POLICY tenant_all ON channel_product_mappings
  FOR ALL TO authenticated
  USING (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

-- -------------------------------------------------------------------------
-- 6) Seed idempotente de canales base para empresas existentes
-- -------------------------------------------------------------------------
INSERT INTO sales_channels (
  company_id,
  provider,
  name,
  kind,
  mode,
  status,
  delivery_mode,
  commission_rate_bps,
  credentials_status,
  settings
)
SELECT
  c.id,
  v.provider,
  v.name,
  v.kind,
  v.mode,
  v.status,
  v.delivery_mode,
  v.commission_rate_bps,
  v.credentials_status,
  v.settings::jsonb
FROM companies c
CROSS JOIN (
  VALUES
    ('whatsapp', 'WhatsApp', 'direct', 'live', 'live_connected', 'own_delivery', 0, 'configured', '{"adapter":"kapso"}'),
    ('storefront', 'Tienda directa', 'direct', 'live', 'live_connected', 'own_delivery', 0, 'configured', '{"adapter":"skipfee_checkout"}'),
    ('rappi', 'Rappi', 'marketplace', 'simulated', 'simulated_ready', 'provider_or_own', 2600, 'missing', '{"docs":"https://dev-portal.rappi.com/"}'),
    ('didi', 'DiDi Food', 'marketplace', 'simulated', 'simulated_ready', 'provider_or_own', 2400, 'missing', '{"docs":"https://developer.didi-food.com/"}'),
    ('ubereats', 'Uber Eats', 'marketplace', 'none', 'live_pending_credentials', 'provider_or_own', 2800, 'missing', '{"blocked":"Sin credenciales en esta fase"}'),
    ('manual', 'POS manual', 'pos', 'none', 'not_configured', 'pickup_or_table', 0, 'missing', '{}')
) AS v(provider, name, kind, mode, status, delivery_mode, commission_rate_bps, credentials_status, settings)
ON CONFLICT (company_id, provider) DO NOTHING;

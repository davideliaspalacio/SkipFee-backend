-- SkipFee · Multi-empresa (Fase 1) · company_id en tablas de negocio
-- =========================================================================
-- Añade company_id NOT NULL a cada tabla de negocio y reescribe los unique
-- globales para que sean POR empresa. Patrón uniforme y seguro:
--   1) ADD COLUMN company_id (nullable)
--   2) backfill de filas existentes a la empresa por defecto
--   3) SET NOT NULL + FK + índice
--
-- Las filas semilla de 0002 (zones, products, settings) se asignan a una
-- "empresa por defecto" para no romper el seed/demo. Tablas vacías quedan
-- igualmente listas. Si la BD no tiene datos, el backfill simplemente no aplica.
--
-- leads queda FUERA: es pre-registro de negocios interesados en SkipFee →
-- pertenece a la plataforma, no a una empresa.
-- =========================================================================

-- Empresa por defecto (recibe el seed/demo "Bros and Subs"). UUID fijo para
-- poder referenciarlo de forma determinista en el backfill.
INSERT INTO companies (id, slug, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'bros-and-subs', 'Bros and Subs')
ON CONFLICT (id) DO NOTHING;

-- Settings por empresa para la empresa por defecto (deja de ser singleton id=1).
INSERT INTO company_integrations (company_id) VALUES ('00000000-0000-0000-0000-000000000001')
ON CONFLICT (company_id) DO NOTHING;

-- -------------------------------------------------------------------------
-- Helper local: añade company_id (NOT NULL + FK + índice) con backfill.
-- -------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  business_tables text[] := ARRAY[
    'zones', 'products', 'customers', 'orders', 'order_items',
    'chats', 'messages', 'cooks', 'promotions', 'order_surveys',
    'rewards', 'bot_messages', 'webhook_events'
  ];
BEGIN
  FOREACH t IN ARRAY business_tables LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS company_id uuid', t);
    EXECUTE format(
      'UPDATE %I SET company_id = %L WHERE company_id IS NULL',
      t, '00000000-0000-0000-0000-000000000001'
    );
    EXECUTE format('ALTER TABLE %I ALTER COLUMN company_id SET NOT NULL', t);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (company_id) REFERENCES companies(id)',
      t, t || '_company_id_fkey'
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(company_id)', t || '_company_id_idx', t);
  END LOOP;
END $$;

-- settings: tratamiento aparte (era fila única id=1 → una fila por empresa).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS company_id uuid;
UPDATE settings SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
ALTER TABLE settings ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE settings ADD CONSTRAINT settings_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id);
-- Quitar el singleton: el id deja de ser fijo en 1.
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_id_check;
ALTER TABLE settings ALTER COLUMN id DROP DEFAULT;
-- id pasa a auto-incrementarse para futuras empresas.
CREATE SEQUENCE IF NOT EXISTS settings_id_seq OWNED BY settings.id;
SELECT setval('settings_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM settings), 0), 1), true);
ALTER TABLE settings ALTER COLUMN id SET DEFAULT nextval('settings_id_seq');
-- Una fila de settings por empresa.
ALTER TABLE settings ADD CONSTRAINT settings_company_id_unique UNIQUE (company_id);

-- =========================================================================
-- Unique constraints globales → por empresa
-- =========================================================================

-- customers.phone: el mismo teléfono puede ser cliente de dos negocios.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_phone_key;
ALTER TABLE customers ADD CONSTRAINT customers_company_phone_unique UNIQUE (company_id, phone);

-- messages.kapso_message_id: dedup por empresa (cada empresa tiene su cuenta Kapso).
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_kapso_message_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS messages_company_kapso_msg_idx
  ON messages (company_id, kapso_message_id)
  WHERE kapso_message_id IS NOT NULL;

-- webhook_events: la idempotency key se vuelve única por empresa.
ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_pkey;
ALTER TABLE webhook_events ADD PRIMARY KEY (company_id, idempotency_key);

-- bot_messages: los textos del bot son por empresa → PK (company_id, key).
ALTER TABLE bot_messages DROP CONSTRAINT IF EXISTS bot_messages_pkey;
ALTER TABLE bot_messages ADD PRIMARY KEY (company_id, key);

-- NOTA: orders.order_number (unique global) se trata en 0039 junto con la
-- numeración por empresa.

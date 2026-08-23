-- =========================================================================
-- SkipFee · Bundle de migraciones 0036 → 0047  (+ empresa de pruebas)
-- =========================================================================
-- Generado por build_migration_bundle.sh — no editar a mano.
--
-- Lleva una BD que está en la migración 0035 (single-tenant) al estado que el
-- backend actual necesita: multi-empresa, canales de venta, dine-in y el puerto
-- multi-proveedor de WhatsApp (Kapso | Evolution).
--
-- CÓMO CORRERLO
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrate_0036_to_0047.sql
--   (o pegarlo completo en el SQL Editor de Supabase)
--
-- ⚠️ DOS TRANSACCIONES, NO UNA
--   La 0045 agrega valores al enum `order_status` y la 0046 los USA. PostgreSQL
--   no permite usar un valor de enum nuevo dentro de la misma transacción que lo
--   creó ("unsafe use of new value"), así que hay un COMMIT obligatorio en medio:
--       Bloque 1: 0036 → 0045   (multi-empresa, canales, valores del enum)
--       Bloque 2: 0046 → 0047   (tablas dine-in, proveedor WhatsApp, seed)
--   Son dos bloques atómicos. Si el 2 falla, el 1 ya quedó aplicado; como todo
--   es reaplicable, se corrige y se vuelve a correr el archivo entero.
--
-- ⚠️ NO DEJES EL BLOQUE 2 A MEDIAS
--   `getCompanyIntegrations` hace SELECT de las columnas de la 0047. Con la 0046
--   aplicada y la 0047 no, se rompe el envío de WhatsApp de TODAS las empresas,
--   también las que usan Kapso.
--
-- QUÉ LE PASA A TUS DATOS
--   La 0038 crea la empresa 'bros-and-subs' (uuid 000…001) y le reasigna TODO lo
--   existente (orders, chats, products, settings, …). Nada se pierde ni se
--   duplica: tu operación actual pasa a ser esa empresa.
--
-- REAPLICABLE: correrlo dos veces no rompe nada ni duplica datos.
-- =========================================================================


-- #########################################################################
-- BLOQUE 1 — 0036 → 0045
-- #########################################################################
BEGIN;

-- =========================================================================
-- >>> 0036_leads.sql
-- =========================================================================
-- 0036_leads.sql · Leads de la campaña de pre-registro (landing /pre-registro)
--
-- Los inserta el backend con service_role vía POST /api/leads. El navegador NUNCA
-- escribe directo a esta tabla. RLS habilitada SIN políticas públicas: el único
-- acceso es server-side con service_role (que bypasea RLS). Así los leads quedan
-- privados (no son legibles por anon/usuarios).

create table if not exists public.leads (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  whatsapp        text,
  business_name   text,
  contact_name    text,
  phone           text,
  email           text,
  contact_channel text,          -- whatsapp | llamada | email
  plan            text,          -- cohorte/oferta, p.ej. 'negocio_regalo'
  orders_volume   text,          -- ej. '30-60', '+100', 'apenas-arranco'
  peak_hours      text,          -- ej. 'almuerzo, noche'
  est_loss        text,          -- ej. '1M-3M', 'no-se'
  city            text,          -- ciudad del restaurante
  current_apps    text,          -- ej. 'Rappi, DiDi Food' | 'Ninguna'
  cuisine_type    text,          -- ej. 'Hamburguesas', 'Comida típica'
  estado          text,          -- 'parcial' | 'calificado'
  source          text default 'landing-preregistro',
  user_agent      text
);

-- RLS on, sin policies: solo service_role (backend) lee/escribe.
alter table public.leads enable row level security;

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_whatsapp_idx on public.leads (whatsapp);


-- =========================================================================
-- >>> 0037_companies_foundation.sql
-- =========================================================================
-- SkipFee · Multi-empresa (Fase 1) · Fundación de tenancy
-- =========================================================================
-- Introduce el concepto de EMPRESA (tenant). A partir de aquí cada dato de
-- negocio pertenece a una empresa y queda aislado del resto.
--
-- Capas de la solución (ver PLAN_MULTI_EMPRESA.md):
--   - companies            → el tenant + su numeración de pedidos
--   - company_integrations → credenciales Kapso/Wompi por empresa (sensibles)
--   - company_members      → usuario ↔ empresa ↔ rol (operativo)
--   - platform_admins      → owner SkipFee, por ENCIMA de las empresas
--
-- Esta migración NO toca aún las tablas de negocio (eso es 0038); solo crea la
-- infraestructura del tenant + las funciones helper de RLS.
-- =========================================================================

-- Roles dentro de una empresa. super_admin manda dentro de SU empresa.
DO $do$ BEGIN
  CREATE TYPE company_role AS ENUM ('super_admin', 'admin', 'cocina', 'empaque');
EXCEPTION WHEN duplicate_object THEN NULL;
END $do$;

DO $do$ BEGIN
  CREATE TYPE company_status AS ENUM ('active', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL;
END $do$;

-- =========================================================================
-- companies — el tenant
-- =========================================================================
CREATE TABLE IF NOT EXISTS companies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- slug: identificador legible que viaja en la ruta /api/<slug>/...
  slug              text NOT NULL UNIQUE,
  name              text NOT NULL,
  status            company_status NOT NULL DEFAULT 'active',
  -- contador de numeración de pedidos POR empresa (#1, #2, ... independiente)
  next_order_number bigint NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS companies_set_updated_at ON companies;
CREATE TRIGGER companies_set_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- company_integrations — secretos por empresa (Kapso/Wompi)
-- ⚠️ Datos sensibles. Acceso solo service_role (sin policy pública). En un
--    endurecimiento posterior conviene cifrar las columnas con Vault/pgsodium.
-- =========================================================================
CREATE TABLE IF NOT EXISTS company_integrations (
  company_id              uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  -- Kapso (WhatsApp) — número + credenciales propias por empresa
  kapso_phone_number_id   text,
  kapso_api_key           text,
  kapso_webhook_secret    text,
  -- Wompi (pagos) — comercio propio por empresa
  wompi_mode              text NOT NULL DEFAULT 'mock',  -- 'mock' | 'real'
  wompi_public_key        text,
  wompi_integrity_secret  text,
  wompi_events_secret     text,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS company_integrations_set_updated_at ON company_integrations;
CREATE TRIGGER company_integrations_set_updated_at
  BEFORE UPDATE ON company_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Resolver la empresa a partir del número que RECIBE el mensaje de WhatsApp.
CREATE UNIQUE INDEX IF NOT EXISTS company_integrations_kapso_phone_idx
  ON company_integrations (kapso_phone_number_id)
  WHERE kapso_phone_number_id IS NOT NULL;

-- =========================================================================
-- company_members — usuario operativo ↔ empresa ↔ rol
-- En esta fase: 1 fila por usuario (un usuario = una empresa). El modelo ya
-- soporta multi-empresa a futuro sin migración.
-- =========================================================================
CREATE TABLE IF NOT EXISTS company_members (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role       company_role NOT NULL DEFAULT 'admin',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);
CREATE INDEX IF NOT EXISTS company_members_company_id_idx ON company_members(company_id);

-- =========================================================================
-- platform_admins — owner SkipFee (capa plataforma)
-- Puede crear empresas y actuar sobre cualquiera.
-- =========================================================================
CREATE TABLE IF NOT EXISTS platform_admins (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =========================================================================
-- Helpers de RLS (SECURITY DEFINER para poder leer las tablas de membresía
-- sin recursión de policies). STABLE: dependen solo de auth.uid() por request.
-- =========================================================================

-- ¿El usuario actual es owner plataforma?
CREATE OR REPLACE FUNCTION is_platform_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_admins pa WHERE pa.user_id = auth.uid()
  );
$$;

-- ¿El usuario actual pertenece a la empresa dada (o es owner plataforma)?
CREATE OR REPLACE FUNCTION is_company_member(target_company uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM company_members m
    WHERE m.user_id = auth.uid() AND m.company_id = target_company
  ) OR is_platform_admin();
$$;

-- =========================================================================
-- RLS de las tablas de tenancy
-- =========================================================================
ALTER TABLE companies            ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins      ENABLE ROW LEVEL SECURITY;

-- companies: un usuario ve la(s) empresa(s) a las que pertenece; el owner ve todas.
DROP POLICY IF EXISTS companies_member_read ON companies;
CREATE POLICY companies_member_read ON companies
  FOR SELECT TO authenticated
  USING (is_company_member(id));

-- company_members: el usuario ve sus propias membresías; el owner ve todas.
DROP POLICY IF EXISTS company_members_self_read ON company_members;
CREATE POLICY company_members_self_read ON company_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR is_platform_admin());

-- company_integrations y platform_admins: sin policy pública → solo service_role.
-- (las maneja el backend/owner; nunca el cliente).


-- =========================================================================
-- >>> 0038_add_company_id.sql
-- =========================================================================
-- SkipFee · Multi-empresa (Fase 1) · company_id en tablas de negocio
-- =========================================================================
-- Añade company_id NOT NULL a cada tabla de negocio y reescribe los unique
-- globales para que sean POR empresa. Patrón uniforme y seguro:
--   1) ADD COLUMN IF NOT EXISTS company_id (nullable)
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
    -- La FK se añade solo si no existe: ADD CONSTRAINT no acepta IF NOT EXISTS,
    -- y sin esta guarda la migración no se puede reaplicar.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = t || '_company_id_fkey'
        AND conrelid = format('public.%I', t)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (company_id) REFERENCES companies(id)',
        t, t || '_company_id_fkey'
      );
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(company_id)', t || '_company_id_idx', t);
  END LOOP;
END $$;

-- settings: tratamiento aparte (era fila única id=1 → una fila por empresa).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS company_id uuid;
UPDATE settings SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
ALTER TABLE settings ALTER COLUMN company_id SET NOT NULL;
DO $c$ BEGIN
  ALTER TABLE settings ADD CONSTRAINT settings_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id);
EXCEPTION WHEN duplicate_object THEN NULL;
          WHEN duplicate_table  THEN NULL;
END $c$;
-- Quitar el singleton: el id deja de ser fijo en 1.
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_id_check;
ALTER TABLE settings ALTER COLUMN id DROP DEFAULT;
-- id pasa a auto-incrementarse para futuras empresas.
CREATE SEQUENCE IF NOT EXISTS settings_id_seq OWNED BY settings.id;
SELECT setval('settings_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM settings), 0), 1), true);
ALTER TABLE settings ALTER COLUMN id SET DEFAULT nextval('settings_id_seq');
-- Una fila de settings por empresa.
DO $c$ BEGIN
  ALTER TABLE settings ADD CONSTRAINT settings_company_id_unique UNIQUE (company_id);
EXCEPTION WHEN duplicate_object THEN NULL;
          WHEN duplicate_table  THEN NULL;
END $c$;
-- =========================================================================
-- Unique constraints globales → por empresa
-- =========================================================================

-- customers.phone: el mismo teléfono puede ser cliente de dos negocios.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_phone_key;
DO $c$ BEGIN
  ALTER TABLE customers ADD CONSTRAINT customers_company_phone_unique UNIQUE (company_id, phone);
EXCEPTION WHEN duplicate_object THEN NULL;
          WHEN duplicate_table  THEN NULL;
END $c$;
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


-- =========================================================================
-- >>> 0039_tenant_policies_and_numbering.sql
-- =========================================================================
-- SkipFee · Multi-empresa (Fase 1) · RLS por empresa + numeración por empresa
-- =========================================================================
-- 1) Reemplaza las policies "public read" (que exponían TODAS las filas, de
--    todas las empresas) por policies de pertenencia: un usuario solo ve/escribe
--    filas de su empresa. El owner plataforma ve todo (is_company_member()).
--    ⚠️ Para que esto proteja de verdad, el backend debe consultar las tablas
--    de negocio con el JWT del usuario (no con service_role, que bypassa RLS).
--    service_role sigue usándose en rutas de sistema (webhooks, cron, bot).
--
-- 2) Numeración de pedidos POR empresa (#1, #2, ... independiente por negocio).
--
-- 3) Asignación de cocinero scopeada a la misma empresa.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1) Policies de pertenencia (tenant_all) en todas las tablas de negocio
-- -------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'zones', 'products', 'customers', 'orders', 'order_items',
    'chats', 'messages', 'cooks', 'promotions', 'order_surveys',
    'rewards', 'bot_messages', 'settings'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- Quitar la lectura pública anterior (filtraba entre empresas).
    EXECUTE format('DROP POLICY IF EXISTS "public read" ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_all ON %I', t);
    -- Lectura y escritura solo dentro de la propia empresa.
    EXECUTE format(
      'CREATE POLICY tenant_all ON %I FOR ALL TO authenticated '
      || 'USING (is_company_member(company_id)) '
      || 'WITH CHECK (is_company_member(company_id))',
      t
    );
  END LOOP;
END $$;

-- webhook_events y company_integrations: sin policy → solo service_role (sistema).
-- leads: tabla de plataforma (pre-registro) → se gestiona aparte (owner).

-- -------------------------------------------------------------------------
-- 2) Numeración de pedidos por empresa
-- -------------------------------------------------------------------------

-- Soltar la numeración global (secuencia + unique global).
ALTER TABLE orders ALTER COLUMN order_number DROP DEFAULT;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_number_unique;
DROP SEQUENCE IF EXISTS orders_order_number_seq;

-- Unicidad por empresa.
DO $c$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_company_order_number_unique
    UNIQUE (company_id, order_number);
EXCEPTION WHEN duplicate_object THEN NULL;
          WHEN duplicate_table  THEN NULL;
END $c$;
-- Poner el contador de cada empresa por encima de sus pedidos ya existentes
-- (la empresa por defecto puede tener pedidos del seed/demo).
UPDATE companies c
   SET next_order_number = GREATEST(
     c.next_order_number,
     COALESCE((SELECT MAX(o.order_number) FROM orders o WHERE o.company_id = c.id), 0) + 1
   );

-- Trigger: al insertar un pedido sin número, tomar y avanzar el contador de SU
-- empresa de forma atómica (el UPDATE ... RETURNING bloquea la fila de companies,
-- así que inserciones concurrentes de la misma empresa se serializan sin colisión).
CREATE OR REPLACE FUNCTION assign_order_number()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.order_number IS NULL THEN
    UPDATE companies
       SET next_order_number = next_order_number + 1
     WHERE id = NEW.company_id
    RETURNING next_order_number - 1 INTO NEW.order_number;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_order_number ON orders;
CREATE TRIGGER trg_assign_order_number
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION assign_order_number();

-- -------------------------------------------------------------------------
-- 3) Asignación de cocinero scopeada por empresa
--    (mismo algoritmo que 0020 pero solo entre cocineros de la MISMA empresa).
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assign_cook_on_paid()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bog_now  timestamp;
  bog_time text;
  day_key  text;
  chosen   text;
BEGIN
  IF NEW.status::text = 'pagado'
     AND NEW.cook_id IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status::text IS DISTINCT FROM 'pagado') THEN

    bog_now  := now() AT TIME ZONE 'America/Bogota';
    bog_time := to_char(bog_now, 'HH24:MI');
    day_key  := (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from bog_now)::int + 1];

    SELECT c.id INTO chosen
    FROM cooks c
    WHERE c.archived = false
      AND c.company_id = NEW.company_id          -- ← solo cocineros de la empresa
      AND (
        c.hours IS NULL
        OR c.hours = '{}'::jsonb
        OR (
          (c.hours -> day_key) IS NOT NULL
          AND NOT COALESCE((c.hours -> day_key ->> 'closed')::boolean, false)
          AND (c.hours -> day_key ->> 'open')  IS NOT NULL
          AND (c.hours -> day_key ->> 'close') IS NOT NULL
          AND (c.hours -> day_key ->> 'open') <> (c.hours -> day_key ->> 'close')
          AND CASE
                WHEN (c.hours -> day_key ->> 'close') > (c.hours -> day_key ->> 'open')
                  THEN bog_time >= (c.hours -> day_key ->> 'open')
                       AND bog_time <  (c.hours -> day_key ->> 'close')
                ELSE
                  bog_time >= (c.hours -> day_key ->> 'open')
                  OR  bog_time <  (c.hours -> day_key ->> 'close')
              END
        )
      )
    ORDER BY
      (SELECT count(*) FROM orders o
        WHERE o.cook_id = c.id
          AND o.company_id = NEW.company_id
          AND o.status::text IN ('pagado', 'cocina')) ASC,
      c.created_at ASC
    LIMIT 1;

    NEW.cook_id := chosen;
  END IF;

  RETURN NEW;
END;
$$;
-- El trigger trg_assign_cook_on_paid de 0020 sigue apuntando a esta función.


-- =========================================================================
-- >>> 0040_company_code.sql
-- =========================================================================
-- SkipFee · Multi-empresa · Código numérico corto de empresa
-- =========================================================================
-- El identificador de empresa que viaja en la URL `/api/<X>/...` pasa de ser
-- el `slug` (revela el nombre del negocio) a un `code` numérico corto y
-- secuencial (1001, 1002, …). El `slug` se CONSERVA como etiqueta legible para
-- display/logs, pero deja de ser el identificador público de la ruta.
--
-- Patrón seguro (sin downtime, columna primero nullable):
--   1) ADD COLUMN IF NOT EXISTS code nullable
--   2) CREATE SEQUENCE START 1001 (propia de esta columna)
--   3) Backfill: asignar code a las empresas con code IS NULL, ordenando por
--      created_at para que la asignación sea determinista.
--   4) SET DEFAULT nextval(seq)  → las empresas nuevas se autoasignan
--   5) SET NOT NULL
--   6) ADD UNIQUE
-- =========================================================================

-- 1) Columna nullable (todavía sin default ni constraint).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS code bigint;

-- 2) Secuencia propia del code, arrancando en 1001.
CREATE SEQUENCE IF NOT EXISTS companies_code_seq AS bigint START WITH 1001 INCREMENT BY 1;

-- 3) Backfill determinista: a cada empresa sin code se le asigna el siguiente
--    valor de la secuencia, ordenando por created_at (y id como desempate).
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
  FROM companies
  WHERE code IS NULL
)
UPDATE companies c
SET code = nextval('companies_code_seq')
FROM ordered o
WHERE c.id = o.id;

-- 4) A partir de ahora, las empresas nuevas se autoasignan el code por DEFAULT.
ALTER TABLE companies ALTER COLUMN code SET DEFAULT nextval('companies_code_seq');

-- La secuencia pertenece a la columna: si se borra la columna, se borra la seq.
ALTER SEQUENCE companies_code_seq OWNED BY companies.code;

-- 5) Ya no puede haber nulls.
ALTER TABLE companies ALTER COLUMN code SET NOT NULL;

-- 6) Unicidad del code (identificador público de la ruta).
DO $c$ BEGIN
  ALTER TABLE companies ADD CONSTRAINT companies_code_key UNIQUE (code);
EXCEPTION WHEN duplicate_object THEN NULL;
          WHEN duplicate_table  THEN NULL;
END $c$;

-- =========================================================================
-- >>> 0041_chat_unread_trigger.sql
-- =========================================================================
-- Mantiene `chats.unread` como contador de mensajes entrantes pendientes
-- de lectura por el operador del panel.

CREATE OR REPLACE FUNCTION increment_chat_unread_on_incoming()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.direction = 'in' THEN
    UPDATE chats
    SET unread = COALESCE(unread, 0) + 1
    WHERE id = NEW.chat_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_increment_chat_unread ON messages;
CREATE TRIGGER messages_increment_chat_unread
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION increment_chat_unread_on_incoming();


-- =========================================================================
-- >>> 0042_chat_phone_lookup_idx.sql
-- =========================================================================
-- Lookup directo desde Pedidos -> WhatsApp.
-- Evita cargar toda la bandeja cuando el panel necesita abrir un chat puntual.
CREATE INDEX IF NOT EXISTS chats_company_phone_idx ON chats(company_id, phone);


-- =========================================================================
-- >>> 0043_marketplace_channels.sql
-- =========================================================================
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


-- =========================================================================
-- >>> 0044_assign_order_number_security_definer.sql
-- =========================================================================
-- SkipFee · Numeración de pedidos segura bajo RLS
-- =========================================================================
-- El trigger de numeración actualiza `companies.next_order_number`. Cuando un
-- pedido se crea desde rutas autenticadas con RLS, esa actualización puede
-- quedar bloqueada por policies de `companies` y terminar con
-- `orders.order_number = null`. SECURITY DEFINER permite que el trigger haga
-- solo esa operación interna sin relajar las policies de la tabla.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.assign_order_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.order_number IS NULL THEN
    UPDATE public.companies
       SET next_order_number = next_order_number + 1
     WHERE id = NEW.company_id
    RETURNING next_order_number - 1 INTO NEW.order_number;
  END IF;

  IF NEW.order_number IS NULL THEN
    RAISE EXCEPTION 'No se pudo asignar order_number para company_id %', NEW.company_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_order_number ON public.orders;

CREATE TRIGGER trg_assign_order_number
  BEFORE INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_order_number();


-- =========================================================================
-- >>> 0045_order_status_dinein_values.sql
-- =========================================================================
-- SkipFee · Estados nuevos de order_status para cuentas de mesa (dine-in)
-- =========================================================================
-- IMPORTANTE: los valores de enum se agregan en su PROPIA migración porque
-- Postgres no permite USAR un valor recién agregado dentro de la misma
-- transacción que lo creó. La migración 0046 (cimientos) sí puede referenciar
-- estos valores (índices/predicados) porque corre en una transacción posterior.
--
--   abierta     → cuenta de mesa abierta: acepta ítems y admite pago/split.
--   por_cobrar  → el cliente pidió la cuenta (paso previo al cierre).
--   cerrada     → cuenta saldada y cerrada; la mesa queda libre.
--
-- El estado `pagado` se REUTILIZA cuando lo recaudado ≥ total (consistencia
-- con reportes y el webhook Wompi). El kanban de delivery ignora estos estados
-- porque filtra por order_type='delivery'.
-- =========================================================================

ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'abierta';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'por_cobrar';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'cerrada';


COMMIT;


-- #########################################################################
-- BLOQUE 2 — 0046 → 0047 + empresa de pruebas
-- (aparte porque usa los valores de enum que agregó la 0045)
-- #########################################################################
BEGIN;

-- =========================================================================
-- >>> 0046_dinein_foundations.sql
-- =========================================================================
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


-- =========================================================================
-- >>> 0047_whatsapp_provider.sql
-- =========================================================================
-- =========================================================================
-- SkipFee · Proveedor de WhatsApp por empresa (Kapso | Evolution)
-- =========================================================================
-- Hasta ahora WhatsApp era SIEMPRE Kapso (Cloud API oficial de Meta), lo que
-- obliga a cada empresa a tener número verificado con Meta. Esta migración
-- introduce un SEGUNDO proveedor posible, Evolution API (self-hosted, conexión
-- por QR como WhatsApp Web), para negocios que no pasan por esa verificación.
--
-- Reglas del modelo:
--   - Una empresa tiene UN proveedor a la vez (nunca los dos). Mezclarlos
--     duplicaría el estado de sesión sin ganar nada.
--   - `kapso` es el default: todas las empresas existentes siguen igual.
--   - Las credenciales de Evolution viven junto a las de Kapso/Wompi, en
--     `company_integrations` (tabla sensible, solo service_role).
--
-- ⚠️ Evolution usa el protocolo NO OFICIAL de WhatsApp Web. Riesgo real de
--    baneo del número del negocio. Es una opción de entrada, no la recomendada.
-- =========================================================================

-- Idempotente: la migración se puede reaplicar sin fallar (útil si el bundle
-- se corre dos veces o si un rollback dejó el esquema a medias).
DO $$ BEGIN
  CREATE TYPE whatsapp_provider AS ENUM ('kapso', 'evolution');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE company_integrations
  ADD COLUMN IF NOT EXISTS whatsapp_provider       whatsapp_provider NOT NULL DEFAULT 'kapso',
  -- Evolution API (self-hosted). `instance` es el nombre de la instancia
  -- dentro del servidor Evolution; `webhook_token` es el secreto compartido
  -- que valida el webhook entrante (Evolution no firma con HMAC como Kapso).
  ADD COLUMN IF NOT EXISTS evolution_base_url      text,
  ADD COLUMN IF NOT EXISTS evolution_api_key       text,
  ADD COLUMN IF NOT EXISTS evolution_instance      text,
  ADD COLUMN IF NOT EXISTS evolution_webhook_token text,
  -- Estado de la sesión reportado por el evento `connection.update`. Kapso no
  -- tiene equivalente: la Cloud API no se "desconecta". Sirve para que el panel
  -- muestre si hay que re-escanear el QR.
  ADD COLUMN IF NOT EXISTS evolution_session_state text,
  ADD COLUMN IF NOT EXISTS evolution_session_updated_at timestamptz;

-- Enrutar un webhook entrante por el nombre de instancia (análogo al índice
-- de `kapso_phone_number_id`). Una instancia pertenece a una sola empresa.
CREATE UNIQUE INDEX IF NOT EXISTS company_integrations_evolution_instance_idx
  ON company_integrations (evolution_instance)
  WHERE evolution_instance IS NOT NULL;

-- =========================================================================
-- chats.pending_options — soporte para la DEGRADACIÓN de interactivos
-- =========================================================================
-- Evolution no soporta botones/listas de forma confiable, así que el adaptador
-- los degrada a un menú de texto numerado ("1. Ver menú / 2. Hacer pedido").
-- Cuando el cliente responde "2" hay que mapear ese "2" de vuelta al id del
-- botón original, o el state machine no lo reconoce y el flujo se rompe.
--
-- Por qué columna aparte y NO dentro de `flow_state`:
--   `processFlowMessage` hace loadFlowState → routeFlow → saveFlowState. Los
--   envíos ocurren DENTRO de routeFlow, así que cualquier cosa que el adaptador
--   escribiera en flow_state sería pisada por el saveFlowState posterior, que
--   guarda el estado calculado ANTES del envío. Una columna independiente tiene
--   su propio ciclo de vida y evita esa carrera.
--
-- Forma: { "options": [{ "key": "1", "id": "btn_pedir", "title": "Hacer pedido" }],
--          "sentAt": "2026-08-21T..." }
ALTER TABLE chats ADD COLUMN IF NOT EXISTS pending_options jsonb;

COMMENT ON COLUMN chats.pending_options IS
  'Opciones del último menú degradado a texto (proveedores sin botones nativos). '
  'Se consume y limpia en el siguiente mensaje entrante del cliente.';


-- =========================================================================
-- >>> Empresa de PRUEBAS (slug: testing)
-- =========================================================================
-- =========================================================================
-- SkipFee · Empresa de PRUEBAS con selector de proveedor de WhatsApp
-- =========================================================================
-- Crea una empresa dedicada a probar el mismo flujo conversacional por Kapso
-- (Cloud API oficial) o por Evolution (canal no oficial por QR), sin tocar un
-- negocio real.
--
-- Requiere la migración 0047_whatsapp_provider.sql aplicada.
--
-- Cómo se conmuta el proveedor (NO se edita esta tabla a mano):
--
--   GET  /api/testing/whatsapp/provider     → proveedor activo + qué hay cargado
--   PUT  /api/testing/whatsapp/provider     → cambiar de proveedor / credenciales
--   POST /api/testing/whatsapp/session      → conectar Evolution y obtener el QR
--   GET  /api/testing/whatsapp/session      → estado de la sesión
--
-- El endpoint valida que existan credenciales ANTES de conmutar, para que la
-- empresa no quede muda y el fallo aparezca recién en el próximo mensaje.
--
-- Arranca en 'kapso' con credenciales vacías: se cargan por el endpoint, no en
-- este seed, para no meter secretos en git.
-- =========================================================================

INSERT INTO companies (slug, name, status)
VALUES ('testing', 'Skipfee Testing', 'active')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
RETURNING id, slug, name;

INSERT INTO company_integrations (company_id, whatsapp_provider, wompi_mode)
SELECT id, 'kapso', 'mock' FROM companies WHERE slug = 'testing'
ON CONFLICT (company_id) DO NOTHING;

-- Fila de settings: el bot la necesita para horarios, tarifas y post-venta.
-- Se copia de la primera empresa existente para heredar valores sensatos; si no
-- hay ninguna, se cae a los defaults de la tabla.
INSERT INTO settings (company_id)
SELECT id FROM companies WHERE slug = 'testing'
ON CONFLICT (company_id) DO NOTHING;

SELECT
  c.slug,
  c.name,
  ci.whatsapp_provider,
  (ci.kapso_api_key IS NOT NULL AND ci.kapso_phone_number_id IS NOT NULL) AS kapso_listo,
  (ci.evolution_base_url IS NOT NULL AND ci.evolution_api_key IS NOT NULL
     AND ci.evolution_instance IS NOT NULL) AS evolution_listo
FROM companies c
JOIN company_integrations ci ON ci.company_id = c.id
WHERE c.slug = 'testing';

COMMIT;

-- =========================================================================
-- Refrescar la cache de esquema de PostgREST. Sin esto la API sigue
-- respondiendo "Could not find the table ... in the schema cache" un rato
-- aunque las tablas ya existan.
-- =========================================================================
NOTIFY pgrst, 'reload schema';

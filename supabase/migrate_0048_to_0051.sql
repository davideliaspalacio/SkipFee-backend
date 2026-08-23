-- =========================================================================
-- SkipFee · Bundle de migraciones 0048 → 0051  ·  Fase 0 del autoservicio
-- =========================================================================
-- Aplicar DESPUÉS de migrate_0036_to_0047.sql.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrate_0048_to_0051.sql
--
-- Qué arregla, en orden de gravedad:
--
--   0048  `zones.id` era clave primaria GLOBAL. Un restaurante nuevo de Medellín
--         que creara su zona "El Poblado" recibía un 500 porque ese id ya lo
--         tenía el negocio piloto. Ahora la PK es (company_id, id) y las FK de
--         customers/orders/chats son compuestas — lo que además impide a nivel
--         de BD que un pedido de la empresa A apunte a una zona de la empresa B.
--
--   0049  Los DEFAULT de `settings` llevaban datos reales del piloto: el bot de
--         cualquier empresa nueva pedía reseñas en SU Google Maps, Despachos
--         calculaba rutas desde SU dirección, y una farmacia arrancaba con
--         categorías de sandwichería. Ahora nacen vacíos. Se agrega
--         `business_description` para que el negocio se describa a sí mismo.
--         ⚠️ Las filas existentes NO se tocan.
--
--   0051  `provision_company()`: el alta de una empresa (companies + members +
--         integrations + settings) pasa a ser UNA transacción en Postgres, en
--         vez de cuatro inserts sueltos con rollback manual en TypeScript. Es el
--         motor que compartirán el owner y el registro público.
--
--   0050  El rol 'mesero' existía en TypeScript pero no en el enum de Postgres:
--         insertarlo fallaba. Va aparte porque un valor de enum nuevo no se
--         puede usar en la misma transacción que lo creó.
--
-- ⚠️ DOS BLOQUES: el enum va fuera de la transacción principal.
-- Reaplicable.
-- =========================================================================


-- #########################################################################
-- BLOQUE 1 — 0048 y 0049
-- #########################################################################
BEGIN;

-- =========================================================================
-- >>> 0048_zones_composite_pk.sql
-- =========================================================================
-- =========================================================================
-- SkipFee · `zones` deja de tener clave primaria GLOBAL
-- =========================================================================
-- BLOQUEANTE DEL AUTOSERVICIO.
--
-- `zones (id text PRIMARY KEY)` viene de la época single-tenant y nunca se
-- convirtió en clave compuesta al migrar a multi-empresa (0037/0038). Pero
-- `POST /api/<code>/zones` genera el id como slug del nombre y solo comprueba
-- unicidad DENTRO de la empresa.
--
-- Resultado: la empresa piloto ya ocupa los ids `poblado`, `envigado`,
-- `laureles` y `fatima`. Cualquier restaurante nuevo de Medellín que cree su
-- zona "El Poblado" recibe un 500 por clave duplicada — un negocio que se
-- registra solo se topa con el error y abandona.
--
-- La PK pasa a ser `(company_id, id)` y las tres FK que la referencian
-- (`customers`, `orders`, `chats`) pasan a ser compuestas. Eso además refuerza
-- el aislamiento: ya es imposible que un pedido de la empresa A apunte a una
-- zona de la empresa B, algo que hoy la BD permite.
--
-- Reaplicable.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Soltar las FK que apuntan a zones(id)
--    Se descubren por catálogo en vez de por nombre: las constraints pueden
--    llamarse distinto según cómo se creó la tabla en cada entorno.
-- -------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conname, rel.relname AS tabla
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_class ref ON ref.oid = con.confrelid
    WHERE con.contype = 'f'
      AND ref.relname = 'zones'
      AND rel.relnamespace = 'public'::regnamespace
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tabla, r.conname);
    RAISE NOTICE 'FK soltada: %.%', r.tabla, r.conname;
  END LOOP;
END $$;

-- -------------------------------------------------------------------------
-- 2. Cambiar la PK de zones a (company_id, id)
-- -------------------------------------------------------------------------
DO $$
DECLARE
  pk_name text;
  cols text;
BEGIN
  SELECT con.conname INTO pk_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE con.contype = 'p' AND rel.relname = 'zones'
    AND rel.relnamespace = 'public'::regnamespace;

  IF pk_name IS NULL THEN
    RAISE NOTICE 'zones no tiene PK; nada que cambiar';
    RETURN;
  END IF;

  -- ¿Ya es la compuesta? Entonces la migración ya corrió.
  SELECT string_agg(a.attname, ',' ORDER BY a.attnum) INTO cols
  FROM pg_constraint con
  JOIN unnest(con.conkey) AS k(attnum) ON true
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
  WHERE con.conname = pk_name AND con.conrelid = 'public.zones'::regclass;

  IF cols = 'id,company_id' OR cols = 'company_id,id' THEN
    RAISE NOTICE 'zones ya tiene PK compuesta; se salta';
    RETURN;
  END IF;

  EXECUTE format('ALTER TABLE zones DROP CONSTRAINT %I', pk_name);
  ALTER TABLE zones ADD PRIMARY KEY (company_id, id);
END $$;

-- -------------------------------------------------------------------------
-- 3. Rehacer las FK como compuestas
--    `chats.zone_id` es nullable: el chat puede no tener zona resuelta aún,
--    así que la FK usa MATCH SIMPLE (default): si zone_id es NULL no se valida.
-- -------------------------------------------------------------------------
DO $c$ BEGIN
  ALTER TABLE customers
    ADD CONSTRAINT customers_zone_fkey
    FOREIGN KEY (company_id, zone_id) REFERENCES zones (company_id, id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $c$;

DO $c$ BEGIN
  ALTER TABLE orders
    ADD CONSTRAINT orders_zone_fkey
    FOREIGN KEY (company_id, zone_id) REFERENCES zones (company_id, id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $c$;

DO $c$ BEGIN
  ALTER TABLE chats
    ADD CONSTRAINT chats_zone_fkey
    FOREIGN KEY (company_id, zone_id) REFERENCES zones (company_id, id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $c$;

-- Índice para las búsquedas por zona dentro de una empresa (la PK ya cubre
-- company_id primero, así que esto solo ayuda a los lookups por id suelto).
CREATE INDEX IF NOT EXISTS zones_id_idx ON zones (id);

COMMENT ON TABLE zones IS
  'Zonas de cobertura por empresa. PK compuesta (company_id, id): dos empresas '
  'pueden tener su propia zona "poblado" sin colisionar.';


-- =========================================================================
-- >>> 0049_settings_sin_identidad_piloto.sql
-- =========================================================================
-- =========================================================================
-- SkipFee · quitar la identidad del negocio piloto de los defaults
-- =========================================================================
-- BLOQUEANTE DEL AUTOSERVICIO.
--
-- `settings` nació single-tenant y sus DEFAULT llevan datos reales de Bros and
-- Subs. Con alta manual daba igual —alguien los corregía—, pero con registro
-- autoservicio una empresa nueva hereda en silencio la identidad del piloto:
--
--   review_link      → el Google Maps de Bros and Subs: el bot pediría reseñas
--                      PARA OTRO NEGOCIO. Es el más grave.
--   local_lat/lng    → la dirección del piloto: Despachos calcula rutas desde ahí
--   local_label      → 'B&S'
--   categories       → categorías de sandwichería (una farmacia arrancaba así)
--   review_gift_name → 'Postre'
--
-- Las columnas pasan a NULL-ables sin default. El onboarding las pide; el código
-- ya las lee con `?? fallback`, así que un NULL no rompe nada (los fallbacks con
-- datos del piloto se limpian en el mismo cambio, del lado del código).
--
-- ⚠️ NO se tocan las filas existentes: Bros and Subs conserva sus valores.
-- Reaplicable.
-- =========================================================================

ALTER TABLE settings ALTER COLUMN review_link      DROP DEFAULT;
ALTER TABLE settings ALTER COLUMN review_link      DROP NOT NULL;

ALTER TABLE settings ALTER COLUMN local_lat        DROP DEFAULT;
ALTER TABLE settings ALTER COLUMN local_lat        DROP NOT NULL;
ALTER TABLE settings ALTER COLUMN local_lng        DROP DEFAULT;
ALTER TABLE settings ALTER COLUMN local_lng        DROP NOT NULL;

ALTER TABLE settings ALTER COLUMN local_label      DROP DEFAULT;
ALTER TABLE settings ALTER COLUMN local_label      DROP NOT NULL;

ALTER TABLE settings ALTER COLUMN review_gift_name DROP DEFAULT;
ALTER TABLE settings ALTER COLUMN review_gift_name DROP NOT NULL;

-- `categories` se queda NOT NULL pero arranca vacío: el código hace `?? []` y
-- un array vacío es más honesto que las categorías de otro rubro.
ALTER TABLE settings ALTER COLUMN categories       SET DEFAULT '{}';

-- -------------------------------------------------------------------------
-- Cómo se describe el negocio a sí mismo.
-- Lo consume el prompt del agente de IA (`lib/bot/prompt.ts`), que hasta ahora
-- decía "Sos el bot de Bros and Subs, una sandwichería gourmet en Medellín"
-- para TODAS las empresas. Lo llena el onboarding.
-- -------------------------------------------------------------------------
ALTER TABLE settings ADD COLUMN IF NOT EXISTS business_description text;

COMMENT ON COLUMN settings.business_description IS
  'Una línea sobre el negocio (ej. "pizzería napolitana en Laureles"). Alimenta '
  'el prompt del agente de IA. NULL = el bot se presenta solo con el nombre.';

COMMENT ON COLUMN settings.review_link IS
  'Link de reseñas del negocio (Google Maps). NULL = no configurado: el bot NO '
  'debe pedir reseña hasta que exista.';
COMMENT ON COLUMN settings.local_lat IS
  'Ubicación del local, para calcular rutas de despacho. NULL = no configurado.';
COMMENT ON COLUMN settings.categories IS
  'Categorías de la carta, propias del rubro. Arranca vacío; lo llena el onboarding.';


-- =========================================================================
-- >>> 0051_provision_company.sql
-- =========================================================================
-- =========================================================================
-- SkipFee · `provision_company()` — alta de empresa ATÓMICA
-- =========================================================================
-- Hoy el alta hace cuatro inserts sueltos (companies, company_members,
-- company_integrations, settings) y, si alguno falla, ejecuta un `cleanup()`
-- a mano en TypeScript que borra en orden inverso.
--
-- Ese patrón tiene dos problemas que con alta manual se toleraban y con
-- registro autoservicio no:
--   1. Si el propio cleanup falla (red caída a mitad), queda un tenant zombi:
--      una empresa sin settings, o con miembro y sin integraciones.
--   2. Entre el primer insert y el último hay una ventana en la que la empresa
--      existe a medias y otra petición podría leerla.
--
-- Una función en Postgres corre en UNA transacción: o quedan las cuatro filas,
-- o no queda ninguna. Sin código de rollback que mantener.
--
-- El usuario de Supabase Auth NO entra aquí (vive fuera de Postgres, en la
-- Admin API). Ese sigue siendo el único paso que el caller debe revertir.
--
-- SECURITY DEFINER porque la RLS impide que nadie salvo service_role escriba en
-- `companies` y `company_members` — ver 0037/0039.
-- =========================================================================

CREATE OR REPLACE FUNCTION provision_company(
  p_slug    text,
  p_name    text,
  p_user_id uuid
)
RETURNS TABLE (
  id                uuid,
  code              bigint,
  slug              text,
  name              text,
  status            company_status,
  next_order_number bigint,
  created_at        timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'slug inválido: %', p_slug
      USING ERRCODE = '22023';
  END IF;

  -- Unicidad explícita: el índice único daría 23505, pero un mensaje claro
  -- ahorra tener que interpretar el código en el caller.
  IF EXISTS (SELECT 1 FROM companies c WHERE c.slug = p_slug) THEN
    RAISE EXCEPTION 'slug ya existe: %', p_slug
      USING ERRCODE = 'unique_violation';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'falta el user_id del super_admin'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO companies (slug, name)
  VALUES (p_slug, p_name)
  RETURNING companies.id INTO v_company_id;

  INSERT INTO company_members (user_id, company_id, role)
  VALUES (p_user_id, v_company_id, 'super_admin');

  -- Filas "vacías": el resto de columnas toma sus DEFAULT. Tras la 0049 esos
  -- defaults ya no llevan la identidad del negocio piloto.
  INSERT INTO company_integrations (company_id) VALUES (v_company_id);
  INSERT INTO settings (company_id) VALUES (v_company_id);

  RETURN QUERY
    SELECT c.id, c.code, c.slug, c.name, c.status, c.next_order_number, c.created_at
    FROM companies c
    WHERE c.id = v_company_id;
END;
$$;

-- Solo el backend (service_role). Nadie autenticado puede provisionarse una
-- empresa a sí mismo llamando a la función desde el cliente.
REVOKE ALL ON FUNCTION provision_company(text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION provision_company(text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION provision_company(text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION provision_company(text, text, uuid) TO service_role;

COMMENT ON FUNCTION provision_company(text, text, uuid) IS
  'Alta atómica de una empresa: companies + company_members(super_admin) + '
  'company_integrations + settings, en una sola transacción. El usuario de Auth '
  'se crea aparte (Admin API) y es responsabilidad del caller revertirlo.';


COMMIT;


-- #########################################################################
-- BLOQUE 2 — 0050 (valor de enum, transacción propia)
-- #########################################################################
BEGIN;

-- =========================================================================
-- SkipFee · agregar 'mesero' al enum company_role
-- =========================================================================
-- El rol existe en TypeScript (`lib/tenant.ts`, `admin-skipfee/lib/roles.ts`)
-- y el módulo de salón lo asume, pero el enum de Postgres nunca lo recibió:
-- 0037 creó ('super_admin','admin','cocina','empaque') y 0046 lo dejó
-- explícitamente para "fase posterior".
--
-- Consecuencia: insertar un `company_members` con rol 'mesero' falla en BD.
--
-- Va en su propia migración porque un valor de enum recién agregado no se puede
-- USAR en la misma transacción que lo creó.
-- =========================================================================

DO $$ BEGIN
  ALTER TYPE company_role ADD VALUE IF NOT EXISTS 'mesero';
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';

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

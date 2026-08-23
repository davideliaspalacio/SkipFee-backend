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

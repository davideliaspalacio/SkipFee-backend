-- Bros and Subs · cocineros + asignación de pedidos
--
-- Reparte la carga de cocina entre los cocineros que estén EN TURNO. Cada
-- cocinero tiene un horario semanal propio (`hours`, mismo shape que
-- settings.hours de 0016) y, al pagarse un pedido, el código (lib/cooks/assign.ts)
-- lo asigna al cocinero disponible-ahora con menos carga activa.
--
-- `cooks.hours` (jsonb): { "mon": {"closed":false,"open":"11:00","close":"22:00"}, ... }
--   - null  → fail-open: se considera siempre disponible (igual que el negocio).
-- `cooks.archived` (bool): soft-delete (mismo patrón que zones en 0017). Los
--   pedidos viejos conservan su cook_id aunque el cocinero se archive.
-- `orders.cook_id`: cocinero asignado (nullable). NULL = sin asignar (nadie en
--   turno al pagar, o pedido previo a esta feature).

CREATE TABLE IF NOT EXISTS cooks (
  id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name       text NOT NULL,
  hours      jsonb,
  archived   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cooks_archived_idx ON cooks(archived) WHERE archived = false;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS cook_id text REFERENCES cooks(id);

-- Acelera el conteo de "carga activa" por cocinero (status pagado/cocina).
CREATE INDEX IF NOT EXISTS orders_cook_active_idx ON orders(cook_id)
  WHERE status IN ('pagado', 'cocina');

-- Seed: 2 cocineros de ejemplo (lun-dom 11:00-22:00). Editables/archivables
-- desde Configuración → Cocineros. Solo si la tabla está vacía. El created_at
-- se escalona 1s para que el desempate por antigüedad sea determinista.
INSERT INTO cooks (name, hours, created_at)
SELECT
  c.name,
  (SELECT jsonb_object_agg(d, jsonb_build_object('closed', false, 'open', '11:00', 'close', '22:00'))
     FROM unnest(ARRAY['mon','tue','wed','thu','fri','sat','sun']) AS d),
  now() + make_interval(secs => c.ord)
FROM (VALUES ('Cocinero 1', 0), ('Cocinero 2', 1)) AS c(name, ord)
WHERE NOT EXISTS (SELECT 1 FROM cooks);

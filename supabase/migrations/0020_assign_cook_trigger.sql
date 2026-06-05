-- Bros and Subs · asignación automática de cocinero al pagar (TRIGGER de BD)
--
-- POR QUÉ un trigger y no código de la app: la asignación debe ocurrir SIEMPRE
-- que un pedido entre en estado 'pagado', sin importar el camino (webhook real
-- de Wompi, webhook mock, mover la tarjeta a "Pagado" en el kanban, o un cambio
-- manual en Supabase) ni qué versión del backend esté desplegada. Un trigger en
-- la base de datos garantiza esa regla de negocio de forma central e infalible.
--
-- Regla (igual que la spec original en TS):
--   - Solo al ENTRAR a 'pagado' y si el pedido aún no tiene cocinero (cook_id NULL).
--   - Candidatos: cocineros no archivados que estén EN TURNO ahora (hora Colombia)
--     según su `hours` semanal. `hours` NULL o '{}' = disponible siempre (fail-open).
--   - Elige el de MENOR carga activa (# de pedidos en 'pagado' o 'cocina')).
--   - Desempate: el cocinero más antiguo (created_at).
--   - Si nadie está disponible, queda sin asignar (cook_id NULL) y se asigna a mano.
--
-- Requiere 0019 (tabla cooks + orders.cook_id) aplicada antes.

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
  -- Solo cuando ENTRA a 'pagado' (no en cada update) y aún no tiene cocinero.
  IF NEW.status::text = 'pagado'
     AND NEW.cook_id IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status::text IS DISTINCT FROM 'pagado') THEN

    bog_now  := now() AT TIME ZONE 'America/Bogota';
    bog_time := to_char(bog_now, 'HH24:MI');
    -- extract(dow): 0=domingo .. 6=sábado → mapear a las claves de `hours`.
    day_key  := (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from bog_now)::int + 1];

    SELECT c.id INTO chosen
    FROM cooks c
    WHERE c.archived = false
      AND (
        -- fail-open: sin horario configurado → disponible siempre
        c.hours IS NULL
        OR c.hours = '{}'::jsonb
        -- o el día actual está abierto y la hora cae dentro del rango
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
                ELSE  -- cruza medianoche (ej. 18:00 → 02:00)
                  bog_time >= (c.hours -> day_key ->> 'open')
                  OR  bog_time <  (c.hours -> day_key ->> 'close')
              END
        )
      )
    ORDER BY
      (SELECT count(*) FROM orders o
        WHERE o.cook_id = c.id AND o.status::text IN ('pagado', 'cocina')) ASC,
      c.created_at ASC
    LIMIT 1;

    -- chosen puede ser NULL (nadie en turno) → el pedido queda sin asignar.
    NEW.cook_id := chosen;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_cook_on_paid ON orders;
CREATE TRIGGER trg_assign_cook_on_paid
  BEFORE INSERT OR UPDATE OF status ON orders
  FOR EACH ROW
  EXECUTE FUNCTION assign_cook_on_paid();

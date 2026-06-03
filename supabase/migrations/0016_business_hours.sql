-- Bros and Subs · horario de operación por día + pausa manual de pedidos
--
-- `hours` (jsonb): horario personalizado POR DÍA. Forma:
--   { "mon": { "closed": false, "open": "11:00", "close": "22:00" }, ... "sun": {...} }
--   - closed=true  → ese día no se atiende.
--   - open/close   → rango "HH:MM" (soporta cruce de medianoche si close <= open).
--
-- `orders_paused` (bool): cierre temporal manual (cocina saturada, etc.) que
--   anula el horario y bloquea pedidos hasta que se desactive.
--
-- El enforcement vive en el código (lib/hours.ts) y es FAIL-OPEN: si `hours`
-- es null, no se bloquea nada (se comporta como antes de esta feature).

ALTER TABLE settings ADD COLUMN IF NOT EXISTS hours jsonb;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS orders_paused boolean NOT NULL DEFAULT false;

-- Seed de `hours` desde el horario legacy (open_hour/close_hour/open_days).
UPDATE settings SET hours = (
  SELECT jsonb_object_agg(
    d,
    CASE WHEN d = ANY(open_days)
      THEN jsonb_build_object('closed', false, 'open', open_hour, 'close', close_hour)
      ELSE jsonb_build_object('closed', true,  'open', open_hour, 'close', close_hour)
    END
  )
  FROM unnest(ARRAY['mon','tue','wed','thu','fri','sat','sun']) AS d
)
WHERE id = 1 AND hours IS NULL;

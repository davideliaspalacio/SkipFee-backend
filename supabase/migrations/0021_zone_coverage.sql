-- Cobertura geográfica de cada zona (Tarea 2: validar dirección con Google).
--
-- coverage: polígono como array JSONB de puntos [{ "lat": .., "lng": .. }] (≥3).
--   null = la zona aún no tiene polígono dibujado → se cae al respaldo por radio.
-- coverage_radius_m: respaldo opcional (radio en metros desde lat/lng) cuando no
--   hay polígono. null = sin respaldo (el punto deberá caer en algún polígono).
--
-- Validación punto-en-polígono se hace en el backend (src/lib/geo/polygon.ts).
-- Si algún día crece, migrar a PostGIS (geometry + ST_Contains).

ALTER TABLE zones ADD COLUMN IF NOT EXISTS coverage          jsonb;
ALTER TABLE zones ADD COLUMN IF NOT EXISTS coverage_radius_m integer;

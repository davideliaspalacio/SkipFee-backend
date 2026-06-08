-- Bros and Subs · dirección del local (origen de los domicilios)
--
-- Hasta ahora el origen de las rutas en el panel Despachos vivía hardcodeado
-- en `frontend/src/lib/data.ts` como ORIGIN = { lat: 6.2447, lng: -75.5736, label: 'B&S' }.
-- Lo movemos a settings para que el dueño lo configure desde el panel.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS local_address text,
  ADD COLUMN IF NOT EXISTS local_lat     double precision NOT NULL DEFAULT 6.2447,
  ADD COLUMN IF NOT EXISTS local_lng     double precision NOT NULL DEFAULT -75.5736,
  ADD COLUMN IF NOT EXISTS local_label   text NOT NULL DEFAULT 'B&S';

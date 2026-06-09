-- Bros and Subs · delay de la encuesta de satisfacción, en MINUTOS
--
-- La encuesta "califícanos" ahora se manda DIFERIDA por el cron survey-dispatch,
-- N minutos después de la entrega (antes era síncrona al marcar "entregado").
-- El dueño la quiere a los 30 min, así que la unidad útil son minutos.
--
-- `survey_delay_hours` (migración 0024) quedó en desuso: se deja la columna vieja
-- dormida (sin DROP) para no tocar datos; el código ya no la lee ni la expone.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS survey_delay_minutes integer NOT NULL DEFAULT 30;

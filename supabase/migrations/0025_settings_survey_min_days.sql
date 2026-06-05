-- Tarea 3 (ajuste): no volver a enviar la encuesta al mismo cliente antes de
-- `survey_min_days` días (evita molestar al recurrente). 0 = sin límite (cada pedido).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS survey_min_days integer NOT NULL DEFAULT 30;

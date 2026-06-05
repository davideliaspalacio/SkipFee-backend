-- Ajustes de post-venta (Tarea 3): encuesta + regalo de postre por reseña.
-- Editables desde el panel (Configuración → Reseñas).

ALTER TABLE settings ADD COLUMN IF NOT EXISTS survey_enabled          boolean NOT NULL DEFAULT true;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS survey_delay_hours      integer NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS review_gift_enabled     boolean NOT NULL DEFAULT true;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS review_gift_name        text    NOT NULL DEFAULT 'Postre';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS review_gift_expiry_days integer NOT NULL DEFAULT 30;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS review_link             text    NOT NULL DEFAULT 'https://maps.app.goo.gl/S3tbdt5KaTnBeioVA';

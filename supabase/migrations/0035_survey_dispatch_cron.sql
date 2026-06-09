-- Cron de encuesta diferida (Tarea: "califícanos" 30 min después de entregar).
--
-- Cada minuto pg_cron llama a /api/cron/survey-dispatch, que manda la encuesta
-- 1–5 a los pedidos entregados hace ≥ settings.survey_delay_minutes (y ≤ 24 h)
-- que aún no la recibieron. Antes la encuesta se enviaba síncrona al marcar
-- "entregado"; ahora se difiere.
--
-- Mismo patrón que 0007_inactivity_cron / 0009_expire_drafts_cron: usa pg_cron +
-- pg_net y reutiliza los GUC app.backend_url / app.cron_secret ya configurados
-- para esos crons.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Reaplicable: si el job ya existía, lo quitamos antes de re-agendarlo (así
-- correr la migración dos veces no falla por nombre duplicado).
DO $$
BEGIN
  PERFORM cron.unschedule('survey-dispatch');
EXCEPTION WHEN OTHERS THEN
  NULL; -- aún no existía: nada que quitar
END $$;

SELECT cron.schedule(
  'survey-dispatch',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.backend_url', true) || '/api/cron/survey-dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.cron_secret', true)
    ),
    body := '{}'::jsonb
  )
  WHERE current_setting('app.backend_url', true) <> '';
  $$
);

-- Para activarlo (una sola vez; ya hecho si corren los otros crons):
--   ALTER DATABASE postgres SET app.backend_url = 'https://tu-backend.vercel.app';
--   ALTER DATABASE postgres SET app.cron_secret = 'un-secret-random-largo';
-- y CRON_SECRET=<el-mismo-secret> en el .env del backend.

-- Cron del carril humano del onboarding.
--
-- Una vez al día (14:00 UTC ≈ 09:00 en Colombia, cuando el equipo ya está
-- despierto para poder llamar) pg_cron llama a /api/cron/onboarding-nudge, que
-- avisa por Discord de los negocios registrados que se quedaron trabados:
-- 48 h sin carta, 72 h sin WhatsApp.
--
-- Mismo patrón que 0007 / 0009 / 0035 / 0054.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  PERFORM cron.unschedule('onboarding-nudge');
EXCEPTION WHEN OTHERS THEN
  NULL; -- aún no existía: nada que quitar
END $$;

SELECT cron.schedule(
  'onboarding-nudge',
  '0 14 * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.backend_url', true) || '/api/cron/onboarding-nudge',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.cron_secret', true)
    ),
    body := '{}'::jsonb
  )
  WHERE current_setting('app.backend_url', true) <> '';
  $$
);

-- Cron de vencimiento de pruebas gratis.
--
-- Una vez al día (05:10 UTC ≈ 00:10 en Colombia) pg_cron llama a
-- /api/cron/trials, que suspende las empresas cuyo `trial_ends_at` ya pasó.
--
-- Diario y no cada minuto a propósito: la prueba se mide en días, y un job que
-- apaga negocios es de los que uno quiere ver correr pocas veces y a una hora
-- previsible. Que caiga de madrugada además evita bloquear a alguien en plena
-- hora de almuerzo.
--
-- Mismo patrón que 0007 / 0009 / 0035: pg_cron + pg_net con los GUC
-- app.backend_url y app.cron_secret ya configurados para esos crons.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  PERFORM cron.unschedule('trials');
EXCEPTION WHEN OTHERS THEN
  NULL; -- aún no existía: nada que quitar
END $$;

SELECT cron.schedule(
  'trials',
  '10 5 * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.backend_url', true) || '/api/cron/trials',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.cron_secret', true)
    ),
    body := '{}'::jsonb
  )
  WHERE current_setting('app.backend_url', true) <> '';
  $$
);

-- Antes de encenderlo en serio conviene dejarlo un par de días con
-- platform_settings.al_vencer = 'avisar': el endpoint reporta a quién le habría
-- vencido sin suspender a nadie.

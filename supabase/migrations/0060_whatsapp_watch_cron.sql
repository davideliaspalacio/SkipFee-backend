-- Cron de vigilancia del canal de WhatsApp.
--
-- Cada 10 minutos pg_cron llama a /api/cron/whatsapp-watch, que le pregunta al
-- servidor de Evolution el estado real de cada negocio ya operativo y
-- sincroniza `evolution_session_state`.
--
-- Cada 10 y no cada minuto: una sesión caída se arregla escaneando un QR, y eso
-- lo hace una persona. Diez minutos es más rápido que cualquier reacción humana
-- posible y no martilla el servidor compartido con una consulta por negocio.
--
-- Mismo patrón que 0007 / 0009 / 0035 / 0054 / 0056: pg_cron + pg_net con los
-- GUC app.backend_url y app.cron_secret.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  PERFORM cron.unschedule('whatsapp-watch');
EXCEPTION WHEN OTHERS THEN
  NULL; -- aún no existía
END $$;

SELECT cron.schedule(
  'whatsapp-watch',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.backend_url', true) || '/api/cron/whatsapp-watch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.cron_secret', true)
    ),
    body := '{}'::jsonb
  )
  WHERE current_setting('app.backend_url', true) <> '';
  $$
);

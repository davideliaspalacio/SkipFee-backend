-- Cron de encuesta post-entrega (Tarea 3). Cada 5 minutos pg_cron llama a
-- /api/cron/survey-dispatch, que envía la encuesta 1–5 a los pedidos entregados
-- hace ≥ survey_delay_hours (y ≤ 24h, dentro de la ventana de sesión de WhatsApp).
--
-- Reutiliza la configuración GUC de 0007 (app.backend_url + app.cron_secret) y
-- el mismo CRON_SECRET del backend.

SELECT cron.schedule(
  'survey-dispatch',
  '*/5 * * * *',
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

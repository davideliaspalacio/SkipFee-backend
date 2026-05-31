-- Cron de expiración de carritos borrador.
--
-- Cada minuto pg_cron llama a /api/cron/expire-drafts, que marca como `expirado`
-- los carritos `borrador` (pre-creados por POST /api/checkout/sessions) cuyo
-- `expires_at` ya pasó y nunca se pagaron. Mismo patrón que 0007_inactivity_cron:
-- pg_cron + pg_net, URL/secret en GUC, header x-cron-secret.
--
-- Requiere las extensiones pg_cron y pg_net (ya activadas por 0007; se repiten
-- con IF NOT EXISTS por si esta migración corre aislada).
--
-- Depende de los valores `borrador`/`expirado` del enum order_status y de la
-- columna orders.expires_at (migración 0008). Aplicar 0008 ANTES que esta.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Reusa app.backend_url / app.cron_secret (se configuran una sola vez, ver 0007).
-- Job cada minuto: POST /api/cron/expire-drafts con el header x-cron-secret.
SELECT cron.schedule(
  'expire-drafts',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.backend_url', true) || '/api/cron/expire-drafts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.cron_secret', true)
    ),
    body := '{}'::jsonb
  )
  WHERE current_setting('app.backend_url', true) <> '';
  $$
);

-- Para activar (si no se hizo ya con 0007), en el SQL Editor de Supabase:
--   ALTER DATABASE postgres SET app.backend_url = 'https://tu-backend.vercel.app';
--   ALTER DATABASE postgres SET app.cron_secret = 'un-secret-random-largo';
-- y agregar CRON_SECRET=<el-mismo-secret> al .env del backend.
--
-- Para desprogramar: SELECT cron.unschedule('expire-drafts');

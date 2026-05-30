-- Cron de inactividad: cada minuto pg_cron llama a un endpoint del backend
-- que detecta chats en flujo del bot que llevan > 5 min sin actividad y
-- les manda un recordatorio. Si llevan > 30 min, limpia el flow_state.
--
-- Requiere las extensiones pg_cron y pg_net (Supabase las soporta en plan
-- pro+ y free experimentales). Si tu proyecto no las tiene activas:
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--   CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- El endpoint del backend es el que decide a quién mandar el nudge.
-- En producción reemplazar BACKEND_URL por el dominio real de Vercel.
-- En dev local NO se puede invocar localhost desde Supabase managed; correr
-- el cron manualmente con `curl` o agendar desde el frontend en su lugar.
--
-- Guardamos la URL en GUC (Grand Unified Configuration) para poder cambiarla
-- vía SQL sin tocar el código del cron.
DO $$
BEGIN
  -- Default a placeholder; cambiar con ALTER DATABASE postgres SET app.backend_url = '...'
  PERFORM set_config('app.backend_url', current_setting('app.backend_url', true), false);
EXCEPTION WHEN OTHERS THEN
  -- Si no estaba seteado, lo dejamos vacío (el cron no hará nada útil hasta configurarse)
  PERFORM set_config('app.backend_url', '', false);
END $$;

-- Job que corre cada minuto. Llama a /api/cron/inactivity-check sin cuerpo;
-- el endpoint hace la query y manda los nudges.
SELECT cron.schedule(
  'inactivity-check',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.backend_url', true) || '/api/cron/inactivity-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.cron_secret', true)
    ),
    body := '{}'::jsonb
  )
  WHERE current_setting('app.backend_url', true) <> '';
  $$
);

-- Para activar el cron, en el SQL Editor de Supabase ejecutar:
--   ALTER DATABASE postgres SET app.backend_url = 'https://tu-backend.vercel.app';
--   ALTER DATABASE postgres SET app.cron_secret = 'un-secret-random-largo';
-- y agregar CRON_SECRET=<el-mismo-secret> al .env del backend.

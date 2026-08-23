-- =========================================================================
-- SkipFee · Bundle 0059 → 0060  ·  alerta de WhatsApp caído
-- =========================================================================
-- Aplicar DESPUÉS de migrate_0058.sql.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrate_0059_to_0060.sql
--   (o pegarlo completo en el SQL Editor de Supabase)
--
--   0059  `companies.operativo_desde`: cuándo el negocio tuvo carta + zona +
--         WhatsApp por primera vez. Separa dos cosas que hoy se confunden — un
--         canal caído NO es un negocio sin montar. Sin esta columna, a un
--         restaurante que lleva meses vendiendo se le cerraría el panel entero
--         al caerse la sesión de WhatsApp, y se le mandaría de vuelta al
--         onboarding. Se rellena con la fecha del primer pedido de cada negocio.
--
--   0060  El cron que cada 10 minutos le pregunta al servidor de Evolution si
--         la sesión sigue viva, porque el webhook es lo primero que se pierde.
--
-- Reaplicable.
-- =========================================================================

-- =========================================================================
-- >>> 0059_operativo_desde.sql
-- =========================================================================
-- =========================================================================
-- SkipFee · cuándo un negocio quedó operativo por primera vez
-- =========================================================================
-- Hoy "puede vender" se calcula al vuelo: carta + zona + WhatsApp conectado.
-- Eso sirve para el checklist, pero NO para decidir dos cosas distintas que
-- dependen de la historia y no del instante:
--
--   1. **El candado del panel.** Se cierra mientras el negocio no pueda vender.
--      Sin esta columna, a un restaurante que lleva meses vendiendo y al que se
--      le cae la sesión de WhatsApp se le bloquearía el panel entero y lo
--      mandaríamos de vuelta al onboarding. Un canal caído no es un negocio sin
--      montar.
--
--   2. **La alerta de WhatsApp desconectado.** Solo tiene sentido para quien ya
--      estuvo conectado. A quien todavía no ha vinculado su número no se le
--      avisa que "se desconectó": nunca lo estuvo.
--
-- Se llena una sola vez, la primera vez que el negocio queda operativo, y no se
-- borra nunca.
--
-- Reaplicable.
-- =========================================================================

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS operativo_desde timestamptz;

COMMENT ON COLUMN public.companies.operativo_desde IS
  'Primera vez que el negocio tuvo carta + zona + WhatsApp a la vez. null = nunca estuvo listo.';

-- Los negocios que ya recibieron pedidos estuvieron operativos, sin duda: se
-- rellena con la fecha de su primer pedido para no dejarlos en el limbo.
UPDATE public.companies c
SET operativo_desde = p.primero
FROM (
  SELECT company_id, min(created_at) AS primero
  FROM public.orders
  WHERE status <> 'borrador'
  GROUP BY company_id
) p
WHERE p.company_id = c.id AND c.operativo_desde IS NULL;


-- =========================================================================
-- >>> 0060_whatsapp_watch_cron.sql
-- =========================================================================
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


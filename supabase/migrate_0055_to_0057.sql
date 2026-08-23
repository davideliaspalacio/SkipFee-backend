-- =========================================================================
-- SkipFee · Bundle 0055 → 0057  ·  carril humano + marca del negocio
-- =========================================================================
-- Aplicar DESPUÉS de migrate_0052_to_0053.sql.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrate_0055_to_0057.sql
--   (o pegarlo completo en el SQL Editor de Supabase)
--
--   0055  `companies.onboarding_nudges`: qué avisos del carril humano ya
--         salieron. Sin esa marca, un negocio atascado genera una alerta diaria
--         hasta desatascarse, que es como se logra que el equipo ignore el canal.
--
--   0056  El cron diario que detecta los atascados (09:00 hora Colombia).
--
--   0057  `settings.logo_url` y `settings.brand_color`: la tienda deja de decir
--         "Skipfee" arriba y pasa a mostrar la marca del restaurante. El color
--         lleva CHECK de formato en la BD porque se inyecta en el CSS de la
--         tienda.
--
-- Reaplicable.
-- =========================================================================

-- =========================================================================
-- >>> 0055_onboarding_nudge.sql
-- =========================================================================
-- =========================================================================
-- SkipFee · marca de "ya avisamos" del carril humano de onboarding
-- =========================================================================
-- El cron /api/cron/onboarding-nudge busca negocios que se registraron y se
-- quedaron a medias (sin carta a las 48 h, sin WhatsApp a las 72 h) y le avisa
-- al equipo para que los llamen.
--
-- Sin esta columna el aviso se repetiría en cada corrida: el mismo negocio
-- atascado generaría una alerta diaria hasta que alguien lo desatasque, que es
-- la forma más rápida de que el equipo aprenda a ignorar el canal.
--
-- Se guarda POR TIPO de aviso (`carta`, `whatsapp`) para que el segundo pueda
-- salir aunque el primero ya haya salido.
--
-- Reaplicable.
-- =========================================================================

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS onboarding_nudges text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.companies.onboarding_nudges IS
  'Avisos de onboarding ya enviados al equipo (carta, whatsapp). Idempotencia del cron.';


-- =========================================================================
-- >>> 0056_onboarding_nudge_cron.sql
-- =========================================================================
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


-- =========================================================================
-- >>> 0057_marca_del_negocio.sql
-- =========================================================================
-- =========================================================================
-- SkipFee · marca del negocio en la tienda
-- =========================================================================
-- Hoy el comensal arma su pedido en una página que dice "Skipfee" arriba. Eso
-- está bien para un piloto y mal para un SaaS: el cliente le compra al
-- restaurante, no a nosotros, y una marca ajena en la pantalla de pago es
-- exactamente donde la gente duda antes de poner la tarjeta.
--
-- Dos campos, no un tema completo: logo y color. Con eso la tienda ya se ve del
-- negocio. Un editor de temas es otra conversación.
--
-- Reaplicable.
-- =========================================================================

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS brand_color text;

COMMENT ON COLUMN public.settings.logo_url IS
  'Logo del negocio (bucket público product-images). null = se muestra el nombre.';
COMMENT ON COLUMN public.settings.brand_color IS
  'Color de marca en hex (#RRGGBB). null = la tienda usa el verde de Skipfee.';

-- Se valida el formato en la BD y no solo en la API: este color se inyecta en
-- el CSS de la tienda, así que un valor libre es una vía de entrada a la hoja
-- de estilos del storefront.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'settings_brand_color_check'
  ) THEN
    ALTER TABLE public.settings
      ADD CONSTRAINT settings_brand_color_check
      CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9a-fA-F]{6}$');
  END IF;
END $$;


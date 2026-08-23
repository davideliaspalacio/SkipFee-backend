-- =========================================================================
-- SkipFee · Bundle de migraciones 0052 → 0053  ·  borrado de empresas + prueba gratis
-- =========================================================================
-- Aplicar DESPUÉS de migrate_0048_to_0051.sql.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrate_0052_to_0053.sql
--   (o pegarlo completo en el SQL Editor de Supabase)
--
--   0052  Ninguna FK a `companies` tenía ON DELETE CASCADE: una empresa con una
--         sola fila de negocio era imposible de borrar. Con registro público eso
--         significa acumular cuentas de spam y altas a medias que nadie puede
--         limpiar. ⚠️ Después de esto, borrar una empresa borra TODO lo suyo.
--
--   0053  El reloj de la prueba gratis (`plan`, `trial_started_at`,
--         `trial_ends_at`) y `platform_settings`: los días de prueba se
--         configuran en un solo número. Las empresas que ya existen pasan a
--         plan 'cortesia' — llevan meses operando y no entran en un embudo de
--         prueba que nace hoy.
--
-- Una sola transacción. Reaplicable.
-- =========================================================================

BEGIN;

-- =========================================================================
-- >>> 0052_companies_on_delete_cascade.sql
-- =========================================================================
-- =========================================================================
-- SkipFee · borrar una empresa arrastra sus datos (ON DELETE CASCADE)
-- =========================================================================
-- Las FK que 0038 creó apuntando a `companies(id)` no llevan acción de borrado,
-- así que Postgres las deja en NO ACTION: **una empresa no se puede borrar**
-- mientras tenga una sola fila en cualquiera de sus 14 tablas de negocio.
--
-- Con alta manual daba igual (nadie borraba empresas). Con registro público sí
-- importa, por dos motivos:
--
--   1. Se van a acumular cuentas abandonadas y de spam, y el owner necesita
--      poder limpiarlas sin escribir 14 DELETE en el orden correcto.
--   2. El rollback del alta: si algo falla después de crear filas de negocio,
--      hoy queda un tenant a medias imposible de borrar por API.
--
-- ⚠️ CUIDADO: tras esta migración, borrar una empresa borra TODOS sus pedidos,
--    clientes, chats y productos, sin vuelta atrás. El endpoint que lo exponga
--    debe pedir confirmación explícita y no debería estar al alcance del propio
--    negocio, solo del owner de la plataforma.
--
-- Reaplicable.
-- =========================================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conname, rel.relname AS tabla
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_class ref ON ref.oid = con.confrelid
    WHERE con.contype = 'f'
      AND ref.relname = 'companies'
      AND rel.relnamespace = 'public'::regnamespace
      AND con.confdeltype <> 'c'   -- 'c' = CASCADE: las que ya lo tienen se saltan
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tabla, r.conname);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (company_id) '
      'REFERENCES companies(id) ON DELETE CASCADE',
      r.tabla, r.conname
    );
    RAISE NOTICE 'CASCADE añadido: %.%', r.tabla, r.conname;
  END LOOP;
END $$;


-- =========================================================================
-- >>> 0053_trial_y_plan.sql
-- =========================================================================
-- =========================================================================
-- SkipFee · prueba gratis: reloj por empresa + configuración de plataforma
-- =========================================================================
-- El bloqueo por suspensión YA existe: `companies.status = 'suspended'`
-- devuelve 403 en seis puntos del backend y los tres crons filtran por
-- empresas activas. Lo que falta es el reloj (cuándo vence) y la palanca
-- (quién y cómo lo cambia).
--
-- Dos decisiones tomadas por el negocio y reflejadas aquí:
--
--   1. El reloj NO arranca al registrarse, sino cuando el negocio queda
--      operativo (carta + zona + WhatsApp). Meta y Wompi pueden comerse media
--      prueba en trámites que no controlamos; cobrarle al dueño ese tiempo es
--      cobrarle nuestra propia fricción. Por eso `trial_started_at` es nullable:
--      null = todavía no arrancó.
--
--   2. Los días de prueba se configuran en un solo sitio y aplican a las altas
--      futuras. `platform_settings` es una tabla de una sola fila (mismo patrón
--      que `settings`), sin lectura pública: es configuración de la plataforma,
--      no de un negocio.
--
-- Reaplicable.
-- =========================================================================

-- --------------------------------------------------------------- companies

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'companies_plan_check'
  ) THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT companies_plan_check
      CHECK (plan IN ('trial', 'activo', 'cortesia'));
  END IF;
END $$;

COMMENT ON COLUMN public.companies.plan IS
  'trial = en prueba gratis · activo = pagando · cortesia = sin vencimiento (piloto, demos, socios).';
COMMENT ON COLUMN public.companies.trial_started_at IS
  'Cuándo quedó operativo el negocio (carta + zona + WhatsApp). null = aún no arranca el reloj.';
COMMENT ON COLUMN public.companies.trial_ends_at IS
  'Vencimiento de la prueba. El cron /api/cron/trials suspende al pasarse.';

-- El piloto y las empresas que ya existen no entran en el embudo de prueba:
-- llevan meses operando y suspenderlas por un reloj que nace hoy sería
-- apagarles el negocio. Quedan en cortesía; el owner las mueve a `activo`
-- cuando haya cobro real.
UPDATE public.companies SET plan = 'cortesia' WHERE plan = 'trial' AND created_at < now();

CREATE INDEX IF NOT EXISTS idx_companies_trial_vencimiento
  ON public.companies (trial_ends_at)
  WHERE plan = 'trial' AND status = 'active';

-- ------------------------------------------------------- platform_settings

CREATE TABLE IF NOT EXISTS public.platform_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Días de prueba que se asignan a los negocios que arranquen de aquí en
  -- adelante. Cambiarlo NO reescribe los relojes ya corriendo: mover la meta a
  -- alguien que está en mitad de la prueba es la clase de sorpresa que hace
  -- que un negocio se vaya.
  trial_days int NOT NULL DEFAULT 14 CHECK (trial_days BETWEEN 1 AND 365),
  -- Al vencer: 'bloquear' suspende la empresa entera (panel y bot).
  al_vencer text NOT NULL DEFAULT 'bloquear' CHECK (al_vencer IN ('bloquear', 'avisar')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

-- Sin policies: solo `service_role` (que bypassa RLS) la lee y escribe. Es
-- configuración de plataforma; ningún cliente tiene por qué verla.
DROP POLICY IF EXISTS platform_settings_public_read ON public.platform_settings;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    DROP TRIGGER IF EXISTS trg_platform_settings_updated_at ON public.platform_settings;
    CREATE TRIGGER trg_platform_settings_updated_at
      BEFORE UPDATE ON public.platform_settings
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;


COMMIT;

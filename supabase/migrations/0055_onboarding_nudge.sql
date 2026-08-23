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

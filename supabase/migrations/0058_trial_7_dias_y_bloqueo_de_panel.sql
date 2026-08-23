-- =========================================================================
-- SkipFee · decisiones de la prueba gratis
-- =========================================================================
-- Cuatro decisiones que el negocio cerró, y que cambian el comportamiento del
-- trial que dejó la 0053:
--
--   1. Sin tarjeta al registrarse. No hay nada que migrar: nunca se construyó
--      la captura de tarjeta. Queda anotado porque la página de precios ya
--      promete "nada de tarjetas" y ahora es verdad.
--
--   2. 7 días, no 14. Un experimento con 337.724 usuarios encontró que 7 supera
--      a 30 y que 14 empata con 30: el tiempo extra no convierte, solo retrasa
--      la decisión.
--
--   3. El reloj arranca AL REGISTRARSE, no al quedar operativo. Es más simple
--      de explicar ("tienes 7 días desde hoy") y no depende de un checklist
--      que el propio dueño controla.
--
--   4. Al vencer se bloquea el PANEL, no la venta. Es la inversión de
--      Tiendanube: el dolor cae sobre quien firma el cheque, no sobre sus
--      clientes. Un restaurante al que le apagamos el WhatsApp en plena hora de
--      almuerzo no vuelve; uno que no puede entrar a su panel, llama.
--
--      Por eso el vencimiento ya NO suspende la empresa. `status = 'suspended'`
--      vuelve a ser lo que era: la palanca manual del owner, que sí apaga todo.
--      El bloqueo del panel lo aplica `getTenantContext` comparando la fecha.
--
-- Reaplicable.
-- =========================================================================

ALTER TABLE public.platform_settings
  ALTER COLUMN trial_days SET DEFAULT 7;

UPDATE public.platform_settings SET trial_days = 7 WHERE id = 1 AND trial_days = 14;

COMMENT ON COLUMN public.platform_settings.al_vencer IS
  'bloquear = se bloquea el panel del negocio (la venta sigue) · avisar = solo se reporta.';

-- Las empresas en prueba que aún no tienen reloj lo arrancan desde su alta:
-- con la regla nueva el trial corre desde que se registraron.
UPDATE public.companies
SET trial_started_at = created_at,
    trial_ends_at = created_at + (
      SELECT make_interval(days => trial_days) FROM public.platform_settings WHERE id = 1
    )
WHERE plan = 'trial' AND trial_started_at IS NULL;

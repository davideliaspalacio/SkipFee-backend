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

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

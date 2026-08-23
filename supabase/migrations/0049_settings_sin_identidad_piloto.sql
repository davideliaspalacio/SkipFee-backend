-- =========================================================================
-- SkipFee · quitar la identidad del negocio piloto de los defaults
-- =========================================================================
-- BLOQUEANTE DEL AUTOSERVICIO.
--
-- `settings` nació single-tenant y sus DEFAULT llevan datos reales de Bros and
-- Subs. Con alta manual daba igual —alguien los corregía—, pero con registro
-- autoservicio una empresa nueva hereda en silencio la identidad del piloto:
--
--   review_link      → el Google Maps de Bros and Subs: el bot pediría reseñas
--                      PARA OTRO NEGOCIO. Es el más grave.
--   local_lat/lng    → la dirección del piloto: Despachos calcula rutas desde ahí
--   local_label      → 'B&S'
--   categories       → categorías de sandwichería (una farmacia arrancaba así)
--   review_gift_name → 'Postre'
--
-- Las columnas pasan a NULL-ables sin default. El onboarding las pide; el código
-- ya las lee con `?? fallback`, así que un NULL no rompe nada (los fallbacks con
-- datos del piloto se limpian en el mismo cambio, del lado del código).
--
-- ⚠️ NO se tocan las filas existentes: Bros and Subs conserva sus valores.
-- Reaplicable.
-- =========================================================================

ALTER TABLE settings ALTER COLUMN review_link      DROP DEFAULT;
ALTER TABLE settings ALTER COLUMN review_link      DROP NOT NULL;

ALTER TABLE settings ALTER COLUMN local_lat        DROP DEFAULT;
ALTER TABLE settings ALTER COLUMN local_lat        DROP NOT NULL;
ALTER TABLE settings ALTER COLUMN local_lng        DROP DEFAULT;
ALTER TABLE settings ALTER COLUMN local_lng        DROP NOT NULL;

ALTER TABLE settings ALTER COLUMN local_label      DROP DEFAULT;
ALTER TABLE settings ALTER COLUMN local_label      DROP NOT NULL;

ALTER TABLE settings ALTER COLUMN review_gift_name DROP DEFAULT;
ALTER TABLE settings ALTER COLUMN review_gift_name DROP NOT NULL;

-- `categories` se queda NOT NULL pero arranca vacío: el código hace `?? []` y
-- un array vacío es más honesto que las categorías de otro rubro.
ALTER TABLE settings ALTER COLUMN categories       SET DEFAULT '{}';

-- -------------------------------------------------------------------------
-- Cómo se describe el negocio a sí mismo.
-- Lo consume el prompt del agente de IA (`lib/bot/prompt.ts`), que hasta ahora
-- decía "Sos el bot de Bros and Subs, una sandwichería gourmet en Medellín"
-- para TODAS las empresas. Lo llena el onboarding.
-- -------------------------------------------------------------------------
ALTER TABLE settings ADD COLUMN IF NOT EXISTS business_description text;

COMMENT ON COLUMN settings.business_description IS
  'Una línea sobre el negocio (ej. "pizzería napolitana en Laureles"). Alimenta '
  'el prompt del agente de IA. NULL = el bot se presenta solo con el nombre.';

COMMENT ON COLUMN settings.review_link IS
  'Link de reseñas del negocio (Google Maps). NULL = no configurado: el bot NO '
  'debe pedir reseña hasta que exista.';
COMMENT ON COLUMN settings.local_lat IS
  'Ubicación del local, para calcular rutas de despacho. NULL = no configurado.';
COMMENT ON COLUMN settings.categories IS
  'Categorías de la carta, propias del rubro. Arranca vacío; lo llena el onboarding.';

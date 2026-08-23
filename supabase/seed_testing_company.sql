-- =========================================================================
-- SkipFee · Empresa de PRUEBAS con selector de proveedor de WhatsApp
-- =========================================================================
-- Crea una empresa dedicada a probar el mismo flujo conversacional por Kapso
-- (Cloud API oficial) o por Evolution (canal no oficial por QR), sin tocar un
-- negocio real.
--
-- Requiere la migración 0047_whatsapp_provider.sql aplicada.
--
-- Cómo se conmuta el proveedor (NO se edita esta tabla a mano):
--
--   GET  /api/testing/whatsapp/provider     → proveedor activo + qué hay cargado
--   PUT  /api/testing/whatsapp/provider     → cambiar de proveedor / credenciales
--   POST /api/testing/whatsapp/session      → conectar Evolution y obtener el QR
--   GET  /api/testing/whatsapp/session      → estado de la sesión
--
-- El endpoint valida que existan credenciales ANTES de conmutar, para que la
-- empresa no quede muda y el fallo aparezca recién en el próximo mensaje.
--
-- Arranca en 'kapso' con credenciales vacías: se cargan por el endpoint, no en
-- este seed, para no meter secretos en git.
-- =========================================================================

INSERT INTO companies (slug, name, status)
VALUES ('testing', 'Skipfee Testing', 'active')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
RETURNING id, slug, name;

INSERT INTO company_integrations (company_id, whatsapp_provider, wompi_mode)
SELECT id, 'kapso', 'mock' FROM companies WHERE slug = 'testing'
ON CONFLICT (company_id) DO NOTHING;

-- Fila de settings: el bot la necesita para horarios, tarifas y post-venta.
-- Se copia de la primera empresa existente para heredar valores sensatos; si no
-- hay ninguna, se cae a los defaults de la tabla.
INSERT INTO settings (company_id)
SELECT id FROM companies WHERE slug = 'testing'
ON CONFLICT (company_id) DO NOTHING;

SELECT
  c.slug,
  c.name,
  ci.whatsapp_provider,
  (ci.kapso_api_key IS NOT NULL AND ci.kapso_phone_number_id IS NOT NULL) AS kapso_listo,
  (ci.evolution_base_url IS NOT NULL AND ci.evolution_api_key IS NOT NULL
     AND ci.evolution_instance IS NOT NULL) AS evolution_listo
FROM companies c
JOIN company_integrations ci ON ci.company_id = c.id
WHERE c.slug = 'testing';

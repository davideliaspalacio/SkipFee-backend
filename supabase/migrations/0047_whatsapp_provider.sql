-- =========================================================================
-- SkipFee · Proveedor de WhatsApp por empresa (Kapso | Evolution)
-- =========================================================================
-- Hasta ahora WhatsApp era SIEMPRE Kapso (Cloud API oficial de Meta), lo que
-- obliga a cada empresa a tener número verificado con Meta. Esta migración
-- introduce un SEGUNDO proveedor posible, Evolution API (self-hosted, conexión
-- por QR como WhatsApp Web), para negocios que no pasan por esa verificación.
--
-- Reglas del modelo:
--   - Una empresa tiene UN proveedor a la vez (nunca los dos). Mezclarlos
--     duplicaría el estado de sesión sin ganar nada.
--   - `kapso` es el default: todas las empresas existentes siguen igual.
--   - Las credenciales de Evolution viven junto a las de Kapso/Wompi, en
--     `company_integrations` (tabla sensible, solo service_role).
--
-- ⚠️ Evolution usa el protocolo NO OFICIAL de WhatsApp Web. Riesgo real de
--    baneo del número del negocio. Es una opción de entrada, no la recomendada.
-- =========================================================================

-- Idempotente: la migración se puede reaplicar sin fallar (útil si el bundle
-- se corre dos veces o si un rollback dejó el esquema a medias).
DO $$ BEGIN
  CREATE TYPE whatsapp_provider AS ENUM ('kapso', 'evolution');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE company_integrations
  ADD COLUMN IF NOT EXISTS whatsapp_provider       whatsapp_provider NOT NULL DEFAULT 'kapso',
  -- Evolution API (self-hosted). `instance` es el nombre de la instancia
  -- dentro del servidor Evolution; `webhook_token` es el secreto compartido
  -- que valida el webhook entrante (Evolution no firma con HMAC como Kapso).
  ADD COLUMN IF NOT EXISTS evolution_base_url      text,
  ADD COLUMN IF NOT EXISTS evolution_api_key       text,
  ADD COLUMN IF NOT EXISTS evolution_instance      text,
  ADD COLUMN IF NOT EXISTS evolution_webhook_token text,
  -- Estado de la sesión reportado por el evento `connection.update`. Kapso no
  -- tiene equivalente: la Cloud API no se "desconecta". Sirve para que el panel
  -- muestre si hay que re-escanear el QR.
  ADD COLUMN IF NOT EXISTS evolution_session_state text,
  ADD COLUMN IF NOT EXISTS evolution_session_updated_at timestamptz;

-- Enrutar un webhook entrante por el nombre de instancia (análogo al índice
-- de `kapso_phone_number_id`). Una instancia pertenece a una sola empresa.
CREATE UNIQUE INDEX IF NOT EXISTS company_integrations_evolution_instance_idx
  ON company_integrations (evolution_instance)
  WHERE evolution_instance IS NOT NULL;

-- =========================================================================
-- chats.pending_options — soporte para la DEGRADACIÓN de interactivos
-- =========================================================================
-- Evolution no soporta botones/listas de forma confiable, así que el adaptador
-- los degrada a un menú de texto numerado ("1. Ver menú / 2. Hacer pedido").
-- Cuando el cliente responde "2" hay que mapear ese "2" de vuelta al id del
-- botón original, o el state machine no lo reconoce y el flujo se rompe.
--
-- Por qué columna aparte y NO dentro de `flow_state`:
--   `processFlowMessage` hace loadFlowState → routeFlow → saveFlowState. Los
--   envíos ocurren DENTRO de routeFlow, así que cualquier cosa que el adaptador
--   escribiera en flow_state sería pisada por el saveFlowState posterior, que
--   guarda el estado calculado ANTES del envío. Una columna independiente tiene
--   su propio ciclo de vida y evita esa carrera.
--
-- Forma: { "options": [{ "key": "1", "id": "btn_pedir", "title": "Hacer pedido" }],
--          "sentAt": "2026-08-21T..." }
ALTER TABLE chats ADD COLUMN IF NOT EXISTS pending_options jsonb;

COMMENT ON COLUMN chats.pending_options IS
  'Opciones del último menú degradado a texto (proveedores sin botones nativos). '
  'Se consume y limpia en el siguiente mensaje entrante del cliente.';

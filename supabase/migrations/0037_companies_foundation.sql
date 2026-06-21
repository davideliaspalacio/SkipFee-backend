-- SkipFee · Multi-empresa (Fase 1) · Fundación de tenancy
-- =========================================================================
-- Introduce el concepto de EMPRESA (tenant). A partir de aquí cada dato de
-- negocio pertenece a una empresa y queda aislado del resto.
--
-- Capas de la solución (ver PLAN_MULTI_EMPRESA.md):
--   - companies            → el tenant + su numeración de pedidos
--   - company_integrations → credenciales Kapso/Wompi por empresa (sensibles)
--   - company_members      → usuario ↔ empresa ↔ rol (operativo)
--   - platform_admins      → owner SkipFee, por ENCIMA de las empresas
--
-- Esta migración NO toca aún las tablas de negocio (eso es 0038); solo crea la
-- infraestructura del tenant + las funciones helper de RLS.
-- =========================================================================

-- Roles dentro de una empresa. super_admin manda dentro de SU empresa.
CREATE TYPE company_role AS ENUM ('super_admin', 'admin', 'cocina', 'empaque');

CREATE TYPE company_status AS ENUM ('active', 'suspended');

-- =========================================================================
-- companies — el tenant
-- =========================================================================
CREATE TABLE companies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- slug: identificador legible que viaja en la ruta /api/<slug>/...
  slug              text NOT NULL UNIQUE,
  name              text NOT NULL,
  status            company_status NOT NULL DEFAULT 'active',
  -- contador de numeración de pedidos POR empresa (#1, #2, ... independiente)
  next_order_number bigint NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER companies_set_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- company_integrations — secretos por empresa (Kapso/Wompi)
-- ⚠️ Datos sensibles. Acceso solo service_role (sin policy pública). En un
--    endurecimiento posterior conviene cifrar las columnas con Vault/pgsodium.
-- =========================================================================
CREATE TABLE company_integrations (
  company_id              uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  -- Kapso (WhatsApp) — número + credenciales propias por empresa
  kapso_phone_number_id   text,
  kapso_api_key           text,
  kapso_webhook_secret    text,
  -- Wompi (pagos) — comercio propio por empresa
  wompi_mode              text NOT NULL DEFAULT 'mock',  -- 'mock' | 'real'
  wompi_public_key        text,
  wompi_integrity_secret  text,
  wompi_events_secret     text,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER company_integrations_set_updated_at
  BEFORE UPDATE ON company_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Resolver la empresa a partir del número que RECIBE el mensaje de WhatsApp.
CREATE UNIQUE INDEX company_integrations_kapso_phone_idx
  ON company_integrations (kapso_phone_number_id)
  WHERE kapso_phone_number_id IS NOT NULL;

-- =========================================================================
-- company_members — usuario operativo ↔ empresa ↔ rol
-- En esta fase: 1 fila por usuario (un usuario = una empresa). El modelo ya
-- soporta multi-empresa a futuro sin migración.
-- =========================================================================
CREATE TABLE company_members (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role       company_role NOT NULL DEFAULT 'admin',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);
CREATE INDEX company_members_company_id_idx ON company_members(company_id);

-- =========================================================================
-- platform_admins — owner SkipFee (capa plataforma)
-- Puede crear empresas y actuar sobre cualquiera.
-- =========================================================================
CREATE TABLE platform_admins (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =========================================================================
-- Helpers de RLS (SECURITY DEFINER para poder leer las tablas de membresía
-- sin recursión de policies). STABLE: dependen solo de auth.uid() por request.
-- =========================================================================

-- ¿El usuario actual es owner plataforma?
CREATE OR REPLACE FUNCTION is_platform_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_admins pa WHERE pa.user_id = auth.uid()
  );
$$;

-- ¿El usuario actual pertenece a la empresa dada (o es owner plataforma)?
CREATE OR REPLACE FUNCTION is_company_member(target_company uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM company_members m
    WHERE m.user_id = auth.uid() AND m.company_id = target_company
  ) OR is_platform_admin();
$$;

-- =========================================================================
-- RLS de las tablas de tenancy
-- =========================================================================
ALTER TABLE companies            ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins      ENABLE ROW LEVEL SECURITY;

-- companies: un usuario ve la(s) empresa(s) a las que pertenece; el owner ve todas.
CREATE POLICY companies_member_read ON companies
  FOR SELECT TO authenticated
  USING (is_company_member(id));

-- company_members: el usuario ve sus propias membresías; el owner ve todas.
CREATE POLICY company_members_self_read ON company_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR is_platform_admin());

-- company_integrations y platform_admins: sin policy pública → solo service_role.
-- (las maneja el backend/owner; nunca el cliente).

-- =========================================================================
-- SkipFee · `provision_company()` — alta de empresa ATÓMICA
-- =========================================================================
-- Hoy el alta hace cuatro inserts sueltos (companies, company_members,
-- company_integrations, settings) y, si alguno falla, ejecuta un `cleanup()`
-- a mano en TypeScript que borra en orden inverso.
--
-- Ese patrón tiene dos problemas que con alta manual se toleraban y con
-- registro autoservicio no:
--   1. Si el propio cleanup falla (red caída a mitad), queda un tenant zombi:
--      una empresa sin settings, o con miembro y sin integraciones.
--   2. Entre el primer insert y el último hay una ventana en la que la empresa
--      existe a medias y otra petición podría leerla.
--
-- Una función en Postgres corre en UNA transacción: o quedan las cuatro filas,
-- o no queda ninguna. Sin código de rollback que mantener.
--
-- El usuario de Supabase Auth NO entra aquí (vive fuera de Postgres, en la
-- Admin API). Ese sigue siendo el único paso que el caller debe revertir.
--
-- SECURITY DEFINER porque la RLS impide que nadie salvo service_role escriba en
-- `companies` y `company_members` — ver 0037/0039.
-- =========================================================================

CREATE OR REPLACE FUNCTION provision_company(
  p_slug    text,
  p_name    text,
  p_user_id uuid
)
RETURNS TABLE (
  id                uuid,
  code              bigint,
  slug              text,
  name              text,
  status            company_status,
  next_order_number bigint,
  created_at        timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'slug inválido: %', p_slug
      USING ERRCODE = '22023';
  END IF;

  -- Unicidad explícita: el índice único daría 23505, pero un mensaje claro
  -- ahorra tener que interpretar el código en el caller.
  IF EXISTS (SELECT 1 FROM companies c WHERE c.slug = p_slug) THEN
    RAISE EXCEPTION 'slug ya existe: %', p_slug
      USING ERRCODE = 'unique_violation';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'falta el user_id del super_admin'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO companies (slug, name)
  VALUES (p_slug, p_name)
  RETURNING companies.id INTO v_company_id;

  INSERT INTO company_members (user_id, company_id, role)
  VALUES (p_user_id, v_company_id, 'super_admin');

  -- Filas "vacías": el resto de columnas toma sus DEFAULT. Tras la 0049 esos
  -- defaults ya no llevan la identidad del negocio piloto.
  INSERT INTO company_integrations (company_id) VALUES (v_company_id);
  INSERT INTO settings (company_id) VALUES (v_company_id);

  RETURN QUERY
    SELECT c.id, c.code, c.slug, c.name, c.status, c.next_order_number, c.created_at
    FROM companies c
    WHERE c.id = v_company_id;
END;
$$;

-- Solo el backend (service_role). Nadie autenticado puede provisionarse una
-- empresa a sí mismo llamando a la función desde el cliente.
REVOKE ALL ON FUNCTION provision_company(text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION provision_company(text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION provision_company(text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION provision_company(text, text, uuid) TO service_role;

COMMENT ON FUNCTION provision_company(text, text, uuid) IS
  'Alta atómica de una empresa: companies + company_members(super_admin) + '
  'company_integrations + settings, en una sola transacción. El usuario de Auth '
  'se crea aparte (Admin API) y es responsabilidad del caller revertirlo.';

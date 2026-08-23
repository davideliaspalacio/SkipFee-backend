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

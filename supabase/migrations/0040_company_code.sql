-- SkipFee · Multi-empresa · Código numérico corto de empresa
-- =========================================================================
-- El identificador de empresa que viaja en la URL `/api/<X>/...` pasa de ser
-- el `slug` (revela el nombre del negocio) a un `code` numérico corto y
-- secuencial (1001, 1002, …). El `slug` se CONSERVA como etiqueta legible para
-- display/logs, pero deja de ser el identificador público de la ruta.
--
-- Patrón seguro (sin downtime, columna primero nullable):
--   1) ADD COLUMN code nullable
--   2) CREATE SEQUENCE START 1001 (propia de esta columna)
--   3) Backfill: asignar code a las empresas con code IS NULL, ordenando por
--      created_at para que la asignación sea determinista.
--   4) SET DEFAULT nextval(seq)  → las empresas nuevas se autoasignan
--   5) SET NOT NULL
--   6) ADD UNIQUE
-- =========================================================================

-- 1) Columna nullable (todavía sin default ni constraint).
ALTER TABLE companies ADD COLUMN code bigint;

-- 2) Secuencia propia del code, arrancando en 1001.
CREATE SEQUENCE IF NOT EXISTS companies_code_seq AS bigint START WITH 1001 INCREMENT BY 1;

-- 3) Backfill determinista: a cada empresa sin code se le asigna el siguiente
--    valor de la secuencia, ordenando por created_at (y id como desempate).
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
  FROM companies
  WHERE code IS NULL
)
UPDATE companies c
SET code = nextval('companies_code_seq')
FROM ordered o
WHERE c.id = o.id;

-- 4) A partir de ahora, las empresas nuevas se autoasignan el code por DEFAULT.
ALTER TABLE companies ALTER COLUMN code SET DEFAULT nextval('companies_code_seq');

-- La secuencia pertenece a la columna: si se borra la columna, se borra la seq.
ALTER SEQUENCE companies_code_seq OWNED BY companies.code;

-- 5) Ya no puede haber nulls.
ALTER TABLE companies ALTER COLUMN code SET NOT NULL;

-- 6) Unicidad del code (identificador público de la ruta).
ALTER TABLE companies ADD CONSTRAINT companies_code_key UNIQUE (code);

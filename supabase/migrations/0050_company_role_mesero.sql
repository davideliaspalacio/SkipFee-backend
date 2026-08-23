-- =========================================================================
-- SkipFee · agregar 'mesero' al enum company_role
-- =========================================================================
-- El rol existe en TypeScript (`lib/tenant.ts`, `admin-skipfee/lib/roles.ts`)
-- y el módulo de salón lo asume, pero el enum de Postgres nunca lo recibió:
-- 0037 creó ('super_admin','admin','cocina','empaque') y 0046 lo dejó
-- explícitamente para "fase posterior".
--
-- Consecuencia: insertar un `company_members` con rol 'mesero' falla en BD.
--
-- Va en su propia migración porque un valor de enum recién agregado no se puede
-- USAR en la misma transacción que lo creó.
-- =========================================================================

DO $$ BEGIN
  ALTER TYPE company_role ADD VALUE IF NOT EXISTS 'mesero';
END $$;

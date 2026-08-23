-- SkipFee · Estados nuevos de order_status para cuentas de mesa (dine-in)
-- =========================================================================
-- IMPORTANTE: los valores de enum se agregan en su PROPIA migración porque
-- Postgres no permite USAR un valor recién agregado dentro de la misma
-- transacción que lo creó. La migración 0046 (cimientos) sí puede referenciar
-- estos valores (índices/predicados) porque corre en una transacción posterior.
--
--   abierta     → cuenta de mesa abierta: acepta ítems y admite pago/split.
--   por_cobrar  → el cliente pidió la cuenta (paso previo al cierre).
--   cerrada     → cuenta saldada y cerrada; la mesa queda libre.
--
-- El estado `pagado` se REUTILIZA cuando lo recaudado ≥ total (consistencia
-- con reportes y el webhook Wompi). El kanban de delivery ignora estos estados
-- porque filtra por order_type='delivery'.
-- =========================================================================

ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'abierta';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'por_cobrar';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'cerrada';

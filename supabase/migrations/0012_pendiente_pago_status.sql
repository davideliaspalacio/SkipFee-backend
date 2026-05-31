-- Estado intermedio `pendiente_pago` entre `borrador` y `pagado`.
--
-- Se setea cuando el cliente disparó el pago en la tienda web (POST a
-- /api/checkout/:orderId/wompi/transaction) y Wompi devolvió `PENDING`.
-- Pasa a `pagado` cuando el webhook confirma APPROVED, o vuelve a `borrador`
-- si DECLINED/ERROR/VOIDED (el cliente puede reintentar).
--
-- En el kanban admin agrega visibilidad de "pagos en curso" — útil para
-- detectar PSE/Nequi colgados (que tardan minutos).
--
-- ⚠️ Postgres: agregar valor a un enum y usarlo en la misma transacción falla.
-- El COMMIT separa los statements (idem migración 0008).

ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'pendiente_pago';

COMMIT;

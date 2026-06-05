-- Cupones de regalo (Tarea 3): postre por dejar reseña, verificado por un humano.
--
-- status: pendiente (cliente mandó screenshot, esperando verificación)
--         → otorgado (humano aprobó; vigente hasta expires_at)
--         → canjeado (usado en un pedido) | expirado | rechazado.
-- Regla de robustez (la cuida el código): un solo reward activo
-- (pendiente/otorgado) por teléfono a la vez; idempotencia por order_id_origen.

CREATE TABLE IF NOT EXISTS rewards (
  id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  phone             text NOT NULL,
  customer_id       text REFERENCES customers(id),
  kind              text NOT NULL DEFAULT 'postre_resena',
  status            text NOT NULL DEFAULT 'pendiente',
  order_id_origen   text REFERENCES orders(id),   -- pedido cuya encuesta lo disparó
  screenshot_url    text,                          -- captura de la reseña (si la tenemos)
  granted_by        text,                          -- email del operario que aprobó
  granted_at        timestamptz,
  redeemed_at       timestamptz,
  redeemed_order_id text REFERENCES orders(id),    -- pedido donde se canjeó
  expires_at        timestamptz,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rewards_phone_status_idx ON rewards (phone, status);

ALTER TABLE rewards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read" ON rewards FOR SELECT USING (true);

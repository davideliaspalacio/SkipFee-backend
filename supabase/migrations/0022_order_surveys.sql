-- Encuesta de satisfacción post-entrega (Tarea 3). Una por pedido.
--
-- La fila se crea al pasar el pedido a 'entregado' (created_at ≈ momento de la
-- entrega). El cron `survey-dispatch` envía la encuesta y marca `sent_at`; cuando
-- el cliente responde 1–5 se guarda `rating` + `responded_at`.

CREATE TABLE IF NOT EXISTS order_surveys (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  order_id     text NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  phone        text NOT NULL,
  rating       integer,                 -- 1..5 (null hasta que responde)
  comment      text,
  sent_at      timestamptz,             -- cuándo se envió la encuesta
  responded_at timestamptz,             -- cuándo respondió
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_surveys_pending_idx ON order_surveys (sent_at, created_at);
CREATE INDEX IF NOT EXISTS order_surveys_phone_idx ON order_surveys (phone);

ALTER TABLE order_surveys ENABLE ROW LEVEL SECURITY;
-- Lectura abierta para el panel (como el resto de tablas); escritura solo service_role.
CREATE POLICY "public read" ON order_surveys FOR SELECT USING (true);

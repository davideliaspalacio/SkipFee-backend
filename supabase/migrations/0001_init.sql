-- Bros and Subs · esquema inicial
-- Espejo de los tipos en frontend/src/lib/data.ts.
-- snake_case en BD; las queries serializan a la forma camelCase que espera el frontend.

-- =========================================================================
-- Enums
-- =========================================================================

CREATE TYPE order_status AS ENUM (
  'nuevo', 'pagado', 'cocina', 'empacado', 'ruta', 'entregado'
);

CREATE TYPE chat_status AS ENUM ('bot', 'human', 'pending');

CREATE TYPE message_direction AS ENUM ('in', 'out', 'bot');

CREATE TYPE customer_tag AS ENUM ('VIP', 'Recurrente', 'Nuevo');

-- =========================================================================
-- Tablas
-- =========================================================================

CREATE TABLE zones (
  id      text PRIMARY KEY,
  name    text NOT NULL,
  tarifa  integer NOT NULL,
  recargo integer NOT NULL,
  color   text NOT NULL,
  lat     double precision NOT NULL,
  lng     double precision NOT NULL
);

CREATE TABLE products (
  id        text PRIMARY KEY,
  name      text NOT NULL,
  price     integer NOT NULL,
  cat       text NOT NULL,
  sold      integer NOT NULL DEFAULT 0,
  available boolean NOT NULL DEFAULT true,
  img       text NOT NULL
);

CREATE TABLE customers (
  id      text PRIMARY KEY,
  name    text NOT NULL,
  phone   text NOT NULL UNIQUE,
  addr    text NOT NULL,
  zone_id text NOT NULL REFERENCES zones(id),
  pedidos integer NOT NULL DEFAULT 0,
  ticket  integer NOT NULL DEFAULT 0,
  ultimo  text NOT NULL DEFAULT '',
  rating  double precision NOT NULL DEFAULT 0,
  tag     customer_tag NOT NULL
);
CREATE INDEX customers_zone_id_idx ON customers(zone_id);

CREATE TABLE orders (
  id             text PRIMARY KEY,
  customer_id    text NOT NULL REFERENCES customers(id),
  total          integer NOT NULL,
  zone_id        text NOT NULL REFERENCES zones(id),
  status         order_status NOT NULL DEFAULT 'nuevo',
  minutos        integer NOT NULL DEFAULT 0,
  address        text NOT NULL,
  phone          text NOT NULL,
  payment_method text NOT NULL,
  note           text,
  lat            double precision NOT NULL,
  lng            double precision NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer_id_idx ON orders(customer_id);
CREATE INDEX orders_zone_id_idx ON orders(zone_id);
CREATE INDEX orders_status_idx ON orders(status);

CREATE TABLE order_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id     text NOT NULL REFERENCES products(id),
  qty            integer NOT NULL,
  price_at_order integer NOT NULL
);
CREATE INDEX order_items_order_id_idx ON order_items(order_id);
CREATE INDEX order_items_product_id_idx ON order_items(product_id);

CREATE TABLE chats (
  id              text PRIMARY KEY,
  customer_id     text REFERENCES customers(id),
  name            text NOT NULL,
  phone           text NOT NULL,
  last            text NOT NULL DEFAULT '',
  time            text NOT NULL DEFAULT '',
  unread          integer NOT NULL DEFAULT 0,
  status          chat_status NOT NULL DEFAULT 'bot',
  zone_id         text REFERENCES zones(id),
  prev_orders     integer NOT NULL DEFAULT 0,
  avg_ticket      integer NOT NULL DEFAULT 0,
  last_message_at timestamptz
);
CREATE INDEX chats_customer_id_idx ON chats(customer_id);
CREATE INDEX chats_zone_id_idx ON chats(zone_id);
CREATE INDEX chats_status_idx ON chats(status);

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id          text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  direction        message_direction NOT NULL,
  body             text NOT NULL,
  media_url        text,
  kapso_message_id text UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz,
  read_at          timestamptz
);
CREATE INDEX messages_chat_id_created_at_idx ON messages(chat_id, created_at);

CREATE TABLE webhook_events (
  idempotency_key text PRIMARY KEY,
  type            text NOT NULL,
  payload         jsonb NOT NULL,
  processed_at    timestamptz NOT NULL DEFAULT now()
);

-- =========================================================================
-- Trigger: updated_at automático en orders
-- =========================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_set_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- Realtime: habilitar broadcasts en tablas que el panel admin escucha en vivo
-- (kanban de pedidos, bandeja WhatsApp).
-- =========================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE orders;
ALTER PUBLICATION supabase_realtime ADD TABLE chats;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;

-- =========================================================================
-- Row Level Security
-- Por ahora activamos RLS y dejamos lectura abierta para el frontend (sin auth todavía).
-- Las escrituras solo las hace el backend con service_role, que bypasea RLS.
-- Cuando activemos Supabase Auth (panel admin con login), endurecemos las policies.
-- =========================================================================

ALTER TABLE zones           ENABLE ROW LEVEL SECURITY;
ALTER TABLE products        ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE chats           ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read" ON zones       FOR SELECT USING (true);
CREATE POLICY "public read" ON products    FOR SELECT USING (true);
CREATE POLICY "public read" ON customers   FOR SELECT USING (true);
CREATE POLICY "public read" ON orders      FOR SELECT USING (true);
CREATE POLICY "public read" ON order_items FOR SELECT USING (true);
CREATE POLICY "public read" ON chats       FOR SELECT USING (true);
CREATE POLICY "public read" ON messages    FOR SELECT USING (true);
-- webhook_events queda completamente cerrado a frontend (solo service_role)

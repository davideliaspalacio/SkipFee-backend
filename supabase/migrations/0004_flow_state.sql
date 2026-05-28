-- Agregar flow_state al chat para el state machine del bot.
-- Guarda el paso actual, carrito en construcción, datos del cliente, etc.

ALTER TABLE chats ADD COLUMN flow_state jsonb;
ALTER TABLE chats ADD COLUMN flow_updated_at timestamptz;

-- Email opcional en customers (lo usa el bot al registrar nuevos clientes)
ALTER TABLE customers ADD COLUMN email text;
ALTER TABLE customers ADD COLUMN lat double precision;
ALTER TABLE customers ADD COLUMN lng double precision;

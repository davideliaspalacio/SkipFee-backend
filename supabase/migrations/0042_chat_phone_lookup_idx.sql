-- Lookup directo desde Pedidos -> WhatsApp.
-- Evita cargar toda la bandeja cuando el panel necesita abrir un chat puntual.
CREATE INDEX IF NOT EXISTS chats_company_phone_idx ON chats(company_id, phone);

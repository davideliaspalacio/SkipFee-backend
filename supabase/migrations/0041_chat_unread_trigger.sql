-- Mantiene `chats.unread` como contador de mensajes entrantes pendientes
-- de lectura por el operador del panel.

CREATE OR REPLACE FUNCTION increment_chat_unread_on_incoming()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.direction = 'in' THEN
    UPDATE chats
    SET unread = COALESCE(unread, 0) + 1
    WHERE id = NEW.chat_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_increment_chat_unread ON messages;
CREATE TRIGGER messages_increment_chat_unread
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION increment_chat_unread_on_incoming();

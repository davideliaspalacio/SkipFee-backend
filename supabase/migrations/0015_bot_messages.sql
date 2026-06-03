-- Bros and Subs · mensajes del bot editables desde la UI
--
-- La tabla guarda SOLO las personalizaciones (overrides). Los textos por
-- defecto viven en el código (src/lib/bot/messages/defaults.ts). Con la tabla
-- vacía el bot se comporta exactamente igual que antes de esta feature.
--
-- `content` (jsonb) tiene una forma distinta según el "kind" del mensaje:
--   text     → { "body": "…" }
--   buttons  → { "body": "…", "buttons": [{ "id": "...", "title": "…" }] }
--   list     → { "body": "…", "buttonText": "…", "rowDescriptionTemplate": "…" }
--   cta_url  → { "body": "…", "displayText": "…" }
--   prompt   → { "systemPrompt": "…", "safeDefault": "…" }
--   keywords → { "words": ["…", "…"] }

CREATE TABLE IF NOT EXISTS bot_messages (
  key         text PRIMARY KEY,
  content     jsonb NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

ALTER TABLE bot_messages ENABLE ROW LEVEL SECURITY;

-- Lectura pública (igual que `settings`). La escritura va por service_role
-- desde el backend (PATCH /api/bot/messages/:key), que bypasea RLS.
CREATE POLICY "public read" ON bot_messages FOR SELECT USING (true);

-- Bros and Subs · soft-delete de zonas
--
-- Las zonas tienen FK desde orders/customers/chats (zone_id). Borrar una zona
-- con historial rompería integridad referencial, así que en vez de borrar las
-- "archivamos": el bot y el admin dejan de ofrecerlas, pero los pedidos viejos
-- conservan su zona.

ALTER TABLE zones ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS zones_archived_idx ON zones(archived) WHERE archived = false;

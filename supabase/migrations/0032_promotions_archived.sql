-- Bros and Subs · soft-delete de promociones
--
-- orders.promo_id apunta a promotions(id) — borrar una promo con pedidos
-- históricos rompería el FK. Archivar (archived=true + active=false) la saca
-- del admin, del storefront y del bot conservando el histórico.

ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;

-- Index parcial: las queries de admin y storefront filtran archived=false.
-- Solo se necesita índice para el set chico de archivadas (reactivar / listar).
CREATE INDEX IF NOT EXISTS promotions_archived_idx
  ON promotions (archived)
  WHERE archived = true;

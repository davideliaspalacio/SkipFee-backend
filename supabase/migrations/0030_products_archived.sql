-- Bros and Subs · archivar productos en vez de eliminarlos
--
-- order_items.product_id apunta a products.id, así que el DELETE físico
-- bloquea con foreign_key_violation en cuanto el producto entra en algún
-- pedido. Soft-delete con un flag `archived` evita perder el histórico y
-- saca al producto del menú, del catálogo admin y del bot en una sola query.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;

-- Index parcial: las queries de catálogo y storefront siempre filtran
-- archived=false, los archivados son un set chico — solo se acceden
-- desde reportes / unarchive manual.
CREATE INDEX IF NOT EXISTS products_archived_idx
  ON products (archived)
  WHERE archived = true;

-- Añade descripción opcional al producto.
--
-- Se muestra en el panel admin (Catálogo: tarjeta + modal de editar) y en
-- el storefront (card del menú del cliente), para que el comensal sepa qué
-- viene en cada sándwich/bowl sin tener que adivinar por el nombre.
--
-- Nullable porque no obligamos al operario a llenarla cuando crea el producto
-- — los productos viejos quedan en NULL hasta que alguien los edite.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS description text;

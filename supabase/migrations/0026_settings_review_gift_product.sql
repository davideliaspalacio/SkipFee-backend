-- Tarea 3 (mejora): el postre de regalo como PRODUCTO real (categoría "Regalo").
--
-- `review_gift_product_id`: producto que se regala (a $0). Se agrega como línea
-- en el carrito de la tienda y como order_item del pedido al pagar (así la cocina
-- lo ve en el kanban como un ítem más). null = sin producto vinculado → cae al
-- comportamiento viejo (solo aviso por `review_gift_name`, sin línea/ítem).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS review_gift_product_id text REFERENCES products(id);

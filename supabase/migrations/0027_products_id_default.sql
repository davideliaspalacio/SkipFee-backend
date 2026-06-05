-- products.id (text PK) nunca recibió un DEFAULT: la 0003 se lo dio a orders y
-- customers pero se saltó products. Por eso crear un producto sin pasar id
-- explícito falla con NOT NULL (afecta al POST /api/products del panel y a la
-- creación del producto de regalo). Le damos el mismo default que orders/customers.
ALTER TABLE products ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;

-- Agregar defaults de id auto-generados a orders y customers.
-- chatsm sigue usando el patrón `wa:<phone>` (id natural por número WhatsApp).
-- Frontend puede mostrar los primeros 6 chars del UUID para UX:
--   "ABC123" en lugar del UUID completo.

ALTER TABLE orders    ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE customers ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;

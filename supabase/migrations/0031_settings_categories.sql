-- Bros and Subs · categorías de productos administrables
--
-- Hasta ahora las categorías eran un array hardcoded en frontend (SEED_CATEGORIES)
-- unidas con las cat de los productos existentes. Movemos la lista a settings
-- para que el dueño pueda agregar/eliminar desde Configuración → Categorías.
--
-- Los valores default coinciden con SEED_CATEGORIES, así nada se rompe en
-- proyectos ya creados.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS categories text[]
  NOT NULL DEFAULT ARRAY['Sándwiches', 'Bebidas', 'Postres', 'Combos'];

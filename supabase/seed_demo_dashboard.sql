-- Skipfee demo seed para grabar el dashboard/admin.
--
-- Uso:
--   1. Asegurate de tener aplicadas las migraciones hasta 0036_leads.sql.
--   2. Ejecuta este archivo en el SQL Editor de Supabase.
--   3. Puedes correrlo varias veces: limpia filas demo y vuelve a sembrarlas.
--
-- Nota de alcance:
--   - La mayoria de filas usan prefijo demo- y se limpian de forma segura.
--   - Tambien actualiza settings(id=1) y las zonas base poblado/laureles/
--     envigado/fatima para que Configuracion y Despachos se vean completos.
--
-- Cubre:
--   - Dashboard: KPIs de hoy, ventas 7d, mix de productos y pedidos en atencion.
--   - Pedidos: kanban con todas las columnas + pagos pendientes/sin pagar.
--   - WhatsApp: conversaciones, mensajes, no leidos y rewards pendientes.
--   - Catalogo/configuracion: productos, zonas, cocineros, promos, bot messages.
--   - Clientes/reportes/postventa: historico 7/30/90d, encuestas y cupones.

BEGIN;

-- ---------------------------------------------------------------------------
-- Compatibilidad M2 / multi-tenant.
-- ---------------------------------------------------------------------------
-- Algunas bases ya tienen company_id NOT NULL en tablas que este checkout local
-- todavia no versiona. Para no tener que duplicar company_id en cada INSERT,
-- resolvemos el tenant existente y lo dejamos como DEFAULT temporal durante
-- esta transaccion. Al final restauramos los defaults originales.
DO $$
DECLARE
  preferred_company_id text := '00000000-0000-0000-0000-000000000001';
  preferred_company_slug text := 'bros-and-subs';
  cid text;
  has_settings_company boolean;
  has_companies boolean;
  r record;
  defaults jsonb := '{}'::jsonb;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'settings'
      AND column_name = 'company_id'
  )
  INTO has_settings_company;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'companies'
  )
  INTO has_companies;

  IF has_companies THEN
    EXECUTE format(
      'SELECT id::text FROM public.companies WHERE id::text = %L OR slug = %L OR lower(name) = %L ORDER BY CASE WHEN id::text = %L THEN 0 WHEN slug = %L THEN 1 ELSE 2 END LIMIT 1',
      preferred_company_id,
      preferred_company_slug,
      'bros and subs',
      preferred_company_id,
      preferred_company_slug
    )
    INTO cid;
  END IF;

  IF cid IS NULL AND has_settings_company THEN
    EXECUTE format(
      'SELECT company_id::text FROM public.settings WHERE company_id::text = %L LIMIT 1',
      preferred_company_id
    )
    INTO cid;
  END IF;

  IF cid IS NULL AND has_settings_company THEN
    EXECUTE 'SELECT company_id::text FROM public.settings WHERE company_id IS NOT NULL ORDER BY id LIMIT 1'
    INTO cid;
  END IF;

  IF cid IS NULL AND has_companies THEN
    EXECUTE 'SELECT id::text FROM public.companies ORDER BY id LIMIT 1'
    INTO cid;
  END IF;

  IF has_settings_company AND cid IS NULL THEN
    RAISE EXCEPTION
      'No pude resolver company_id. Crea/selecciona una empresa primero o reemplaza el resolver del seed con el company_id correcto.';
  END IF;

  IF cid IS NULL THEN
    RAISE NOTICE 'Seed demo: esquema sin company_id; se sembrara en modo single-tenant.';
  ELSE
    RAISE NOTICE 'Seed demo: usando company_id=%', cid;
  END IF;

  PERFORM set_config('skipfee_demo.company_id', COALESCE(cid, ''), true);

  FOR r IN
    SELECT
      cls.relname AS table_name,
      pg_catalog.format_type(attr.atttypid, attr.atttypmod) AS type_expr,
      pg_get_expr(def.adbin, def.adrelid) AS default_expr
    FROM pg_class cls
    JOIN pg_namespace ns ON ns.oid = cls.relnamespace
    JOIN pg_attribute attr ON attr.attrelid = cls.oid
    LEFT JOIN pg_attrdef def ON def.adrelid = cls.oid AND def.adnum = attr.attnum
    WHERE ns.nspname = 'public'
      AND cls.relkind = 'r'
      AND attr.attname = 'company_id'
      AND NOT attr.attisdropped
      AND cls.relname IN (
        'settings', 'zones', 'products', 'customers', 'orders', 'order_items',
        'chats', 'messages', 'rewards', 'order_surveys', 'promotions', 'cooks',
        'leads', 'bot_messages'
      )
  LOOP
    defaults := defaults || jsonb_build_object(
      r.table_name,
      jsonb_build_object(
        'type_expr', r.type_expr,
        'default_expr', r.default_expr
      )
    );

    IF cid IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN company_id SET DEFAULT %L::%s',
        r.table_name,
        cid,
        r.type_expr
      );
    END IF;
  END LOOP;

  PERFORM set_config('skipfee_demo.company_defaults', defaults::text, true);
END $$;

-- ---------------------------------------------------------------------------
-- Limpieza idempotente de la corrida demo anterior.
-- ---------------------------------------------------------------------------
DELETE FROM messages
WHERE chat_id LIKE 'demo-chat-%';

DELETE FROM chats
WHERE id LIKE 'demo-chat-%';

DELETE FROM rewards
WHERE id LIKE 'demo-reward-%';

DELETE FROM order_surveys
WHERE id LIKE 'demo-survey-%'
   OR order_id LIKE 'demo-order-%';

DELETE FROM order_items
WHERE order_id LIKE 'demo-order-%';

DELETE FROM orders
WHERE id LIKE 'demo-order-%';

UPDATE settings
SET review_gift_product_id = NULL
WHERE review_gift_product_id LIKE 'demo-prod-%';

DELETE FROM products p
WHERE p.id LIKE 'demo-prod-%'
  AND NOT EXISTS (
    SELECT 1 FROM order_items oi
    WHERE oi.product_id = p.id
  );

DELETE FROM customers c
WHERE c.id LIKE 'demo-customer-%'
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.customer_id = c.id
      AND o.id NOT LIKE 'demo-order-%'
  );

DELETE FROM promotions p
WHERE p.id LIKE 'demo-promo-%'
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.promo_id = p.id
      AND o.id NOT LIKE 'demo-order-%'
  );

DELETE FROM cooks c
WHERE c.id LIKE 'demo-cook-%'
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.cook_id = c.id
      AND o.id NOT LIKE 'demo-order-%'
  );

DELETE FROM leads
WHERE source = 'demo-dashboard-seed';

DELETE FROM bot_messages
WHERE updated_by = 'demo-dashboard-seed';

-- ---------------------------------------------------------------------------
-- Configuracion base del negocio.
-- ---------------------------------------------------------------------------
INSERT INTO settings (id)
SELECT 1
WHERE NOT EXISTS (
  SELECT 1 FROM settings WHERE id = 1
);

UPDATE settings
SET
  open_hour = '11:00',
  close_hour = '22:30',
  open_days = ARRAY['mon','tue','wed','thu','fri','sat','sun'],
  peak_start = '12:00',
  peak_end = '14:00',
  peak_surcharge = 0,
  base_delivery_fee = 5000,
  reminder_minutes = 6,
  delivered_window_hours = 12,
  hours = '{
    "mon":{"closed":false,"open":"11:00","close":"22:30"},
    "tue":{"closed":false,"open":"11:00","close":"22:30"},
    "wed":{"closed":false,"open":"11:00","close":"22:30"},
    "thu":{"closed":false,"open":"11:00","close":"22:30"},
    "fri":{"closed":false,"open":"11:00","close":"23:30"},
    "sat":{"closed":false,"open":"11:30","close":"23:30"},
    "sun":{"closed":false,"open":"12:00","close":"21:30"}
  }'::jsonb,
  orders_paused = false,
  survey_enabled = true,
  survey_delay_minutes = 30,
  survey_min_days = 14,
  review_gift_enabled = true,
  review_gift_name = 'Brownie de cortesia',
  review_gift_expiry_days = 30,
  review_link = 'https://maps.app.goo.gl/S3tbdt5KaTnBeioVA',
  review_gift_product_id = NULL,
  local_address = 'Cra. 43A #10-10, Manila, Medellin',
  local_lat = 6.21084,
  local_lng = -75.57150,
  local_label = 'Bros and Subs',
  categories = ARRAY['Sandwiches','Combos','Bebidas','Postres','Regalo'],
  updated_at = now()
WHERE id = 1;

-- ---------------------------------------------------------------------------
-- Zonas de cobertura.
-- ---------------------------------------------------------------------------
WITH dz (id, name, tarifa, recargo, color, lat, lng, archived, coverage, coverage_radius_m) AS (
  VALUES
    ('poblado', 'El Poblado', 5200, 0, '#E85D04', 6.20870::double precision, -75.56580::double precision, false, '[{"lat":6.2290,"lng":-75.5850},{"lat":6.2305,"lng":-75.5510},{"lat":6.2035,"lng":-75.5410},{"lat":6.1810,"lng":-75.5740},{"lat":6.1990,"lng":-75.5960}]'::jsonb, 4200),
    ('laureles', 'Laureles', 5800, 0, '#5E6AD2', 6.24860::double precision, -75.59330::double precision, false, '[{"lat":6.2630,"lng":-75.6120},{"lat":6.2660,"lng":-75.5810},{"lat":6.2440,"lng":-75.5740},{"lat":6.2290,"lng":-75.5980},{"lat":6.2390,"lng":-75.6170}]'::jsonb, 3900),
    ('envigado', 'Envigado', 6500, 0, '#606C38', 6.16960::double precision, -75.59210::double precision, false, '[{"lat":6.1900,"lng":-75.6040},{"lat":6.1890,"lng":-75.5690},{"lat":6.1580,"lng":-75.5580},{"lat":6.1390,"lng":-75.5890},{"lat":6.1590,"lng":-75.6160}]'::jsonb, 4500),
    ('fatima', 'Fatima', 6200, 0, '#A16207', 6.23640::double precision, -75.60280::double precision, false, '[{"lat":6.2490,"lng":-75.6150},{"lat":6.2480,"lng":-75.5920},{"lat":6.2290,"lng":-75.5860},{"lat":6.2170,"lng":-75.6050},{"lat":6.2280,"lng":-75.6220}]'::jsonb, 3200)
)
UPDATE zones z
SET
  name = dz.name,
  tarifa = dz.tarifa,
  recargo = dz.recargo,
  color = dz.color,
  lat = dz.lat,
  lng = dz.lng,
  archived = dz.archived,
  coverage = dz.coverage,
  coverage_radius_m = dz.coverage_radius_m
FROM dz
WHERE z.id = dz.id;

WITH dz (id, name, tarifa, recargo, color, lat, lng, archived, coverage, coverage_radius_m) AS (
  VALUES
    ('poblado', 'El Poblado', 5200, 0, '#E85D04', 6.20870::double precision, -75.56580::double precision, false, '[{"lat":6.2290,"lng":-75.5850},{"lat":6.2305,"lng":-75.5510},{"lat":6.2035,"lng":-75.5410},{"lat":6.1810,"lng":-75.5740},{"lat":6.1990,"lng":-75.5960}]'::jsonb, 4200),
    ('laureles', 'Laureles', 5800, 0, '#5E6AD2', 6.24860::double precision, -75.59330::double precision, false, '[{"lat":6.2630,"lng":-75.6120},{"lat":6.2660,"lng":-75.5810},{"lat":6.2440,"lng":-75.5740},{"lat":6.2290,"lng":-75.5980},{"lat":6.2390,"lng":-75.6170}]'::jsonb, 3900),
    ('envigado', 'Envigado', 6500, 0, '#606C38', 6.16960::double precision, -75.59210::double precision, false, '[{"lat":6.1900,"lng":-75.6040},{"lat":6.1890,"lng":-75.5690},{"lat":6.1580,"lng":-75.5580},{"lat":6.1390,"lng":-75.5890},{"lat":6.1590,"lng":-75.6160}]'::jsonb, 4500),
    ('fatima', 'Fatima', 6200, 0, '#A16207', 6.23640::double precision, -75.60280::double precision, false, '[{"lat":6.2490,"lng":-75.6150},{"lat":6.2480,"lng":-75.5920},{"lat":6.2290,"lng":-75.5860},{"lat":6.2170,"lng":-75.6050},{"lat":6.2280,"lng":-75.6220}]'::jsonb, 3200)
)
INSERT INTO zones (
  id, name, tarifa, recargo, color, lat, lng, archived, coverage, coverage_radius_m
)
SELECT
  dz.id, dz.name, dz.tarifa, dz.recargo, dz.color, dz.lat, dz.lng,
  dz.archived, dz.coverage, dz.coverage_radius_m
FROM dz
WHERE NOT EXISTS (
  SELECT 1 FROM zones z WHERE z.id = dz.id
);

-- ---------------------------------------------------------------------------
-- Catalogo demo.
-- ---------------------------------------------------------------------------
INSERT INTO products (
  id, name, price, cat, sold, available, img, description, archived
) VALUES
  ('demo-prod-pastrami-bros', 'Pastrami Bros', 28500, 'Sandwiches', 0, true, 'https://loremflickr.com/640/480/pastrami,sandwich?lock=501', 'Pastrami de la casa, mostaza antigua, pepinillos y pan artesanal.', false),
  ('demo-prod-cubano-clasico', 'Cubano Clasico', 26500, 'Sandwiches', 0, true, 'https://loremflickr.com/640/480/cuban,sandwich?lock=502', 'Cerdo rostizado, jamon, queso suizo, pepinillos y mostaza.', false),
  ('demo-prod-porchetta', 'Porchetta Italiana', 33500, 'Sandwiches', 0, true, 'https://loremflickr.com/640/480/porchetta,sandwich?lock=503', 'Porchetta crocante, salsa verde, rugula y focaccia tostada.', false),
  ('demo-prod-reuben', 'Reuben de Brisket', 31500, 'Sandwiches', 0, true, 'https://loremflickr.com/640/480/reuben,brisket,sandwich?lock=504', 'Brisket ahumado, sauerkraut, queso y salsa bros.', false),
  ('demo-prod-pollo-buffalo', 'Pollo Buffalo', 24500, 'Sandwiches', 0, true, 'https://loremflickr.com/640/480/buffalo,chicken,sandwich?lock=505', 'Pollo crispy, buffalo, ranch de la casa y repollo fresco.', false),
  ('demo-prod-smash-doble', 'Smash Burger Doble', 28500, 'Sandwiches', 0, true, 'https://loremflickr.com/640/480/smash,burger?lock=506', 'Doble carne smash, cheddar, cebolla grillada y salsa secreta.', false),
  ('demo-prod-veggie-bros', 'Veggie Bros', 23500, 'Sandwiches', 0, false, 'https://loremflickr.com/640/480/veggie,sandwich?lock=507', 'Portobello, vegetales asados, queso y pesto. Agotado para mostrar estado.', false),
  ('demo-prod-combo-pastrami', 'Combo Pastrami + Coca Zero', 34500, 'Combos', 0, true, 'https://loremflickr.com/640/480/sandwich,soda,combo?lock=508', 'Pastrami Bros con Coca-Cola Zero 400 ml.', false),
  ('demo-prod-combo-cubano', 'Combo Cubano + Club', 35500, 'Combos', 0, true, 'https://loremflickr.com/640/480/sandwich,beer,combo?lock=509', 'Cubano Clasico con Club Colombia fria.', false),
  ('demo-prod-coca-zero', 'Coca-Cola Zero 400 ml', 6500, 'Bebidas', 0, true, 'https://loremflickr.com/640/480/coca,cola?lock=510', 'Botella personal fria.', false),
  ('demo-prod-limonada-coco', 'Limonada de Coco', 9000, 'Bebidas', 0, true, 'https://loremflickr.com/640/480/coconut,lemonade?lock=511', 'Limonada cremosa preparada al momento.', false),
  ('demo-prod-club-colombia', 'Club Colombia Dorada', 8500, 'Bebidas', 0, true, 'https://loremflickr.com/640/480/beer,bottle?lock=512', 'Cerveza fria para combos y pedidos nocturnos.', false),
  ('demo-prod-agua-gas', 'Agua con gas', 5500, 'Bebidas', 0, true, 'https://loremflickr.com/640/480/sparkling,water?lock=513', 'Agua con gas personal.', false),
  ('demo-prod-brownie', 'Brownie con helado', 12500, 'Postres', 0, true, 'https://loremflickr.com/640/480/brownie,icecream?lock=514', 'Brownie tibio con helado de vainilla.', false),
  ('demo-prod-cheesecake', 'Cheesecake de frutos rojos', 12000, 'Postres', 0, true, 'https://loremflickr.com/640/480/cheesecake,berries?lock=515', 'Porcion cremosa con salsa de frutos rojos.', false),
  ('demo-prod-brownie-cortesia', 'Brownie de cortesia', 0, 'Regalo', 0, true, 'https://loremflickr.com/640/480/brownie,chocolate?lock=516', 'Postre gratis para clientes con recompensa aprobada.', false);

UPDATE settings
SET review_gift_product_id = 'demo-prod-brownie-cortesia'
WHERE id = 1;

-- ---------------------------------------------------------------------------
-- Cocineros y promociones.
-- ---------------------------------------------------------------------------
INSERT INTO cooks (id, name, hours, archived, created_at, updated_at)
VALUES
  ('demo-cook-ana', 'Ana Maria', '{
    "mon":{"closed":false,"open":"10:30","close":"18:30"},
    "tue":{"closed":false,"open":"10:30","close":"18:30"},
    "wed":{"closed":false,"open":"10:30","close":"18:30"},
    "thu":{"closed":false,"open":"10:30","close":"18:30"},
    "fri":{"closed":false,"open":"10:30","close":"18:30"},
    "sat":{"closed":false,"open":"11:30","close":"18:30"},
    "sun":{"closed":true,"open":"11:00","close":"18:00"}
  }'::jsonb, false, now() - interval '180 days', now()),
  ('demo-cook-julian', 'Julian', '{
    "mon":{"closed":false,"open":"14:00","close":"23:30"},
    "tue":{"closed":false,"open":"14:00","close":"23:30"},
    "wed":{"closed":false,"open":"14:00","close":"23:30"},
    "thu":{"closed":false,"open":"14:00","close":"23:30"},
    "fri":{"closed":false,"open":"14:00","close":"23:59"},
    "sat":{"closed":false,"open":"12:00","close":"23:59"},
    "sun":{"closed":false,"open":"12:00","close":"21:30"}
  }'::jsonb, false, now() - interval '160 days', now()),
  ('demo-cook-mateo', 'Mateo', null, false, now() - interval '120 days', now()),
  ('demo-cook-lina', 'Lina', '{
    "mon":{"closed":true,"open":"11:00","close":"22:00"},
    "tue":{"closed":true,"open":"11:00","close":"22:00"},
    "wed":{"closed":false,"open":"11:00","close":"16:00"},
    "thu":{"closed":false,"open":"11:00","close":"16:00"},
    "fri":{"closed":false,"open":"11:00","close":"16:00"},
    "sat":{"closed":false,"open":"11:00","close":"16:00"},
    "sun":{"closed":false,"open":"12:00","close":"18:00"}
  }'::jsonb, true, now() - interval '220 days', now());

INSERT INTO promotions (
  id, kind, name, description, discount_type, discount_value, min_subtotal,
  config, active, archived, starts_at, ends_at, created_at, updated_at
) VALUES
  (
    'demo-promo-combo-dia', 'product', 'Combo del dia: Pastrami',
    '15% sobre Pastrami Bros y Combo Pastrami para mover el almuerzo.',
    'percent', 15, 30000,
    '{"product_ids":["demo-prod-pastrami-bros","demo-prod-combo-pastrami"]}'::jsonb,
    true, false, now() - interval '2 days', now() + interval '12 days', now() - interval '2 days', now()
  ),
  (
    'demo-promo-miercoles', 'weekday', 'Miercoles de combos',
    'Descuento automatico para combos en mitad de semana.',
    'fixed', 5000, 45000,
    '{"weekdays":[3],"starts_hhmm":"11:00","ends_hhmm":"22:00","product_ids":["demo-prod-combo-pastrami","demo-prod-combo-cubano"]}'::jsonb,
    true, false, now() - interval '10 days', now() + interval '30 days', now() - interval '10 days', now()
  ),
  (
    'demo-promo-archivada', 'weekday', 'Promo vieja de apertura',
    'Archivada para que el panel tambien tenga historial.',
    'percent', 10, 0,
    '{"weekdays":[5,6]}'::jsonb,
    false, true, now() - interval '90 days', now() - interval '40 days', now() - interval '90 days', now() - interval '40 days'
  );

-- ---------------------------------------------------------------------------
-- Clientes.
-- ---------------------------------------------------------------------------
INSERT INTO customers (
  id, name, phone, addr, zone_id, pedidos, ticket, ultimo, rating, tag, email, lat, lng
) VALUES
  ('demo-customer-001', 'Maria Camila Ruiz', '+573126451209', 'Cra. 35 #8-71, El Poblado', 'poblado', 14, 40500, now()::text, 4.9, 'VIP', 'maria.ruiz@example.com', 6.20990, -75.56690),
  ('demo-customer-002', 'Andres Felipe Ochoa', '+573041178821', 'Cl. 33 #74-12, Laureles', 'laureles', 9, 39200, now()::text, 4.7, 'Recurrente', 'andres.ochoa@example.com', 6.24530, -75.59650),
  ('demo-customer-003', 'Laura Mejia Jaramillo', '+573205580033', 'Cl. 37 Sur #28-04, Envigado', 'envigado', 18, 44800, now()::text, 5.0, 'VIP', 'laura.mejia@example.com', 6.16790, -75.58950),
  ('demo-customer-004', 'Santiago Hoyos', '+573189026614', 'Cra. 80 #44-21, Laureles', 'laureles', 4, 31500, now()::text, 4.5, 'Recurrente', 'santiago.hoyos@example.com', 6.25180, -75.60410),
  ('demo-customer-005', 'Valentina Cardona', '+573123328941', 'Cra. 43A #11-50, El Poblado', 'poblado', 2, 28500, now()::text, 4.6, 'Nuevo', 'valentina.cardona@example.com', 6.20770, -75.57130),
  ('demo-customer-006', 'Miguel Angel Posada', '+573014127700', 'Cra. 78 #50A-30, Laureles', 'laureles', 12, 42100, now()::text, 4.8, 'VIP', 'miguel.posada@example.com', 6.25810, -75.59960),
  ('demo-customer-007', 'Daniela Arango', '+573208871102', 'Cl. 12 Sur #43E-20, El Poblado', 'poblado', 5, 33700, now()::text, 4.7, 'Recurrente', 'daniela.arango@example.com', 6.20080, -75.57320),
  ('demo-customer-008', 'Juan Pablo Tobon', '+573180459912', 'Cra. 47 #32 Sur-110, Envigado', 'envigado', 11, 43900, now()::text, 4.9, 'VIP', 'juan.tobon@example.com', 6.17430, -75.59220),
  ('demo-customer-009', 'Catalina Builes', '+573127764413', 'Cl. 18 #41-22, El Poblado', 'poblado', 6, 36500, now()::text, 4.6, 'Recurrente', 'catalina.builes@example.com', 6.21860, -75.56880),
  ('demo-customer-010', 'Mateo Restrepo Salazar', '+573045598814', 'Cra. 73 #B-21, Fatima', 'fatima', 2, 29800, now()::text, 4.3, 'Nuevo', 'mateo.restrepo@example.com', 6.23280, -75.60610),
  ('demo-customer-011', 'Sofia Restrepo', '+573189045512', 'Cra. 37 #10-22, Manila', 'poblado', 1, 27400, now()::text, 4.4, 'Nuevo', 'sofia.restrepo@example.com', 6.21160, -75.57020),
  ('demo-customer-012', 'Tomas Aristizabal', '+573014421188', 'Cl. 30A #65D-40, Belen', 'fatima', 3, 31200, now()::text, 4.2, 'Recurrente', 'tomas.aristizabal@example.com', 6.23020, -75.59980),
  ('demo-customer-013', 'Isabela Hoyos', '+573043115566', 'Transv. 32D #9 Sur-75', 'poblado', 10, 41700, now()::text, 4.9, 'Recurrente', 'isabela.hoyos@example.com', 6.19490, -75.56050),
  ('demo-customer-014', 'Felipe Quintero', '+573120889921', 'Av. Nutibara #70-45', 'laureles', 7, 35100, now()::text, 4.6, 'Recurrente', 'felipe.quintero@example.com', 6.24740, -75.59060),
  ('demo-customer-015', 'Manuela Echavarria', '+573218883301', 'Loma del Esmeraldal #12-80', 'envigado', 8, 40200, now()::text, 4.8, 'Recurrente', 'manuela.echavarria@example.com', 6.16190, -75.58340),
  ('demo-customer-016', 'Nicolas Velez', '+573004446677', 'Cra. 66B #34-09, Fatima', 'fatima', 1, 28800, now()::text, 4.1, 'Nuevo', 'nicolas.velez@example.com', 6.23510, -75.61070),
  ('demo-customer-017', 'Antonia Jaramillo', '+573223334455', 'Cra. 25 #7 Sur-90', 'poblado', 13, 46800, now()::text, 4.9, 'VIP', 'antonia.jaramillo@example.com', 6.19810, -75.55290),
  ('demo-customer-018', 'Emilio Alvarez', '+573155559900', 'Cl. 38 Sur #43-55', 'envigado', 4, 33200, now()::text, 4.4, 'Recurrente', 'emilio.alvarez@example.com', 6.17030, -75.58160);

-- ---------------------------------------------------------------------------
-- Pedidos explicitos de hoy: dashboard + kanban.
-- ---------------------------------------------------------------------------
WITH clock AS (
  SELECT (date_trunc('day', now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota') AS today_start
),
rows (
  id, customer_id, status, total, tip, tip_percent, discount, promo_id,
  cook_id, payment_method, note, minutes_ago, expires_in_minutes
) AS (
  VALUES
    ('demo-order-live-001','demo-customer-011','nuevo',47000,0,NULL::integer,0,NULL,NULL,'Wompi - link enviado','Cliente pidio confirmar direccion por WhatsApp',18,NULL::integer),
    ('demo-order-live-002','demo-customer-002','pagado',66500,4000,10,5000,'demo-promo-combo-dia','demo-cook-ana','Wompi - Tarjeta','Sin cebolla y salsas aparte',82,NULL),
    ('demo-order-live-003','demo-customer-003','cocina',83500,5000,NULL,0,NULL,'demo-cook-julian','Wompi - PSE','Pedido corporativo, marcar bolsas por nombre',64,NULL),
    ('demo-order-live-004','demo-customer-014','cocina',41500,0,NULL,0,NULL,'demo-cook-ana','Wompi - Nequi','Pan bien tostado',34,NULL),
    ('demo-order-live-005','demo-customer-006','empacado',59000,3000,10,0,NULL,'demo-cook-mateo','Wompi - Tarjeta','Tocar timbre, no llamar',51,NULL),
    ('demo-order-live-006','demo-customer-010','ruta',38000,0,NULL,0,NULL,'demo-cook-julian','Wompi - PSE','Porteria torre 2',73,NULL),
    ('demo-order-live-007','demo-customer-012','pagado',52500,2000,NULL,0,NULL,'demo-cook-mateo','Wompi - Tarjeta','Agregar servilletas extra',26,NULL),
    ('demo-order-live-008','demo-customer-016','nuevo',35500,0,NULL,0,NULL,NULL,'Contraentrega dataphone','Cliente nuevo desde Instagram',9,NULL),
    ('demo-order-unpaid-001','demo-customer-005','borrador',44000,0,NULL,0,NULL,NULL,'Checkout web','Carrito armado, pendiente de pago',12,22),
    ('demo-order-unpaid-002','demo-customer-013','pendiente_pago',70500,3500,10,5000,'demo-promo-combo-dia',NULL,'Wompi - PSE pendiente','PSE en autorizacion',31,18),
    ('demo-order-today-001','demo-customer-001','entregado',74200,4200,10,5000,'demo-promo-combo-dia','demo-cook-ana','Wompi - Tarjeta','Entregado sin novedad',42,NULL),
    ('demo-order-today-002','demo-customer-017','entregado',62000,0,NULL,0,NULL,'demo-cook-julian','Wompi - PSE','Cliente pidio factura',58,NULL),
    ('demo-order-today-003','demo-customer-008','entregado',92000,7000,NULL,0,NULL,'demo-cook-mateo','Wompi - Tarjeta','Pedido familiar',96,NULL),
    ('demo-order-today-004','demo-customer-004','entregado',40500,0,NULL,0,NULL,'demo-cook-ana','Wompi - Nequi','Sin pepinillos',125,NULL),
    ('demo-order-today-005','demo-customer-009','entregado',55500,2500,NULL,0,NULL,'demo-cook-julian','Wompi - Tarjeta','Dejar en recepcion',168,NULL),
    ('demo-order-today-006','demo-customer-015','entregado',68500,3000,10,5000,'demo-promo-combo-dia','demo-cook-mateo','Wompi - PSE','Llamar al llegar',214,NULL),
    ('demo-order-today-007','demo-customer-007','entregado',38500,0,NULL,0,NULL,'demo-cook-ana','Wompi - Tarjeta','Sin picante',262,NULL),
    ('demo-order-today-008','demo-customer-018','entregado',47700,2200,NULL,0,NULL,'demo-cook-julian','Wompi - Tarjeta','Agregar cubiertos',318,NULL)
),
prepared AS (
  SELECT
    r.*,
    c.zone_id,
    c.addr,
    c.phone,
    c.lat,
    c.lng,
    greatest(clock.today_start + interval '15 minutes', now() - make_interval(mins => r.minutes_ago)) AS created_at
  FROM rows r
  JOIN customers c ON c.id = r.customer_id
  CROSS JOIN clock
)
INSERT INTO orders (
  id, customer_id, total, zone_id, status, address, phone, payment_method, note,
  lat, lng, created_at, updated_at, tip, tip_percent, discount, promo_id, cook_id,
  notified_statuses, delivered_at, expires_at, wompi_tx_id, wompi_status_message
)
SELECT
  id,
  customer_id,
  total,
  zone_id,
  status::order_status,
  addr,
  phone,
  payment_method,
  note,
  lat,
  lng,
  created_at,
  CASE
    WHEN status = 'entregado' THEN least(now(), created_at + interval '38 minutes')
    ELSE least(now(), created_at + interval '12 minutes')
  END,
  tip,
  tip_percent,
  discount,
  promo_id,
  cook_id,
  CASE status
    WHEN 'nuevo' THEN ARRAY[]::text[]
    WHEN 'pagado' THEN ARRAY['pagado']::text[]
    WHEN 'cocina' THEN ARRAY['pagado','cocina']::text[]
    WHEN 'empacado' THEN ARRAY['pagado','cocina']::text[]
    WHEN 'ruta' THEN ARRAY['pagado','cocina','ruta']::text[]
    WHEN 'entregado' THEN ARRAY['pagado','cocina','ruta','entregado']::text[]
    ELSE ARRAY[]::text[]
  END,
  CASE WHEN status = 'entregado' THEN least(now() - interval '2 minutes', created_at + interval '35 minutes') END,
  CASE WHEN status IN ('borrador','pendiente_pago') THEN now() + make_interval(mins => expires_in_minutes) END,
  CASE WHEN status NOT IN ('nuevo','borrador') THEN 'demo-wompi-' || id END,
  CASE WHEN status = 'pendiente_pago' THEN 'PENDING - esperando confirmacion de banco' END
FROM prepared;

-- Historico entregado del periodo actual para reportes/clientes.
WITH clock AS (
  SELECT (date_trunc('day', now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota') AS today_start
),
generated AS (
  SELECT
    'demo-order-hist-' || lpad(g::text, 3, '0') AS id,
    'demo-customer-' || lpad((((g - 1) % 18) + 1)::text, 3, '0') AS customer_id,
    (ARRAY[36500,42000,48500,53200,61000,45500,39800,73500,58000,44500,69000,51200])[(g - 1) % 12 + 1] + ((g % 5) * 1800) AS total,
    (ARRAY['demo-cook-ana','demo-cook-julian','demo-cook-mateo'])[(g - 1) % 3 + 1] AS cook_id,
    ((g - 1) % 27) + 1 AS days_ago,
    (11 * 60) + ((g * 37) % 610) AS minute_of_day,
    CASE WHEN g % 6 = 0 THEN 2500 ELSE 0 END AS tip,
    CASE WHEN g % 6 = 0 THEN 10 ELSE NULL::integer END AS tip_percent,
    CASE WHEN g % 7 = 0 THEN 5000 ELSE 0 END AS discount,
    CASE WHEN g % 7 = 0 THEN 'demo-promo-combo-dia' ELSE NULL END AS promo_id
  FROM generate_series(1, 64) AS g
),
prepared AS (
  SELECT
    g.*,
    c.zone_id,
    c.addr,
    c.phone,
    c.lat,
    c.lng,
    clock.today_start - make_interval(days => g.days_ago) + make_interval(mins => g.minute_of_day) AS created_at
  FROM generated g
  JOIN customers c ON c.id = g.customer_id
  CROSS JOIN clock
)
INSERT INTO orders (
  id, customer_id, total, zone_id, status, address, phone, payment_method, note,
  lat, lng, created_at, updated_at, tip, tip_percent, discount, promo_id, cook_id,
  notified_statuses, delivered_at, wompi_tx_id
)
SELECT
  id,
  customer_id,
  total,
  zone_id,
  'entregado'::order_status,
  addr,
  phone,
  CASE WHEN (right(id, 1)::int % 3) = 0 THEN 'Wompi - PSE' ELSE 'Wompi - Tarjeta' END,
  CASE WHEN (right(id, 1)::int % 8) = 0 THEN 'Pedido historico con nota de cocina' END,
  lat,
  lng,
  created_at,
  created_at + interval '42 minutes',
  tip,
  tip_percent,
  discount,
  promo_id,
  cook_id,
  ARRAY['pagado','cocina','ruta','entregado']::text[],
  created_at + interval '38 minutes',
  'demo-wompi-' || id
FROM prepared;

-- Periodo anterior: deja comparativos positivos en Reportes.
WITH clock AS (
  SELECT (date_trunc('day', now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota') AS today_start
),
generated AS (
  SELECT
    'demo-order-prev-' || lpad(g::text, 3, '0') AS id,
    'demo-customer-' || lpad((((g + 4) % 18) + 1)::text, 3, '0') AS customer_id,
    (ARRAY[28500,33000,37800,41500,46200,39000,35200,52000])[(g - 1) % 8 + 1] + ((g % 4) * 1200) AS total,
    (ARRAY['demo-cook-ana','demo-cook-julian','demo-cook-mateo'])[(g - 1) % 3 + 1] AS cook_id,
    31 + ((g - 1) % 28) AS days_ago,
    (11 * 60) + ((g * 43) % 570) AS minute_of_day
  FROM generate_series(1, 38) AS g
),
prepared AS (
  SELECT
    g.*,
    c.zone_id,
    c.addr,
    c.phone,
    c.lat,
    c.lng,
    clock.today_start - make_interval(days => g.days_ago) + make_interval(mins => g.minute_of_day) AS created_at
  FROM generated g
  JOIN customers c ON c.id = g.customer_id
  CROSS JOIN clock
)
INSERT INTO orders (
  id, customer_id, total, zone_id, status, address, phone, payment_method, note,
  lat, lng, created_at, updated_at, tip, tip_percent, discount, promo_id, cook_id,
  notified_statuses, delivered_at, wompi_tx_id
)
SELECT
  id,
  customer_id,
  total,
  zone_id,
  'entregado'::order_status,
  addr,
  phone,
  CASE WHEN (right(id, 1)::int % 2) = 0 THEN 'Wompi - PSE' ELSE 'Wompi - Tarjeta' END,
  NULL,
  lat,
  lng,
  created_at,
  created_at + interval '45 minutes',
  0,
  NULL,
  0,
  NULL,
  cook_id,
  ARRAY['pagado','cocina','ruta','entregado']::text[],
  created_at + interval '40 minutes',
  'demo-wompi-' || id
FROM prepared;

-- ---------------------------------------------------------------------------
-- Items de pedidos explicitos.
-- ---------------------------------------------------------------------------
WITH explicit_items(order_id, product_id, qty) AS (
  VALUES
    ('demo-order-live-001','demo-prod-pastrami-bros',1),
    ('demo-order-live-001','demo-prod-coca-zero',1),
    ('demo-order-live-002','demo-prod-combo-pastrami',2),
    ('demo-order-live-002','demo-prod-limonada-coco',1),
    ('demo-order-live-003','demo-prod-porchetta',2),
    ('demo-order-live-003','demo-prod-club-colombia',2),
    ('demo-order-live-004','demo-prod-cubano-clasico',1),
    ('demo-order-live-004','demo-prod-brownie',1),
    ('demo-order-live-005','demo-prod-reuben',1),
    ('demo-order-live-005','demo-prod-smash-doble',1),
    ('demo-order-live-006','demo-prod-combo-cubano',1),
    ('demo-order-live-007','demo-prod-pollo-buffalo',2),
    ('demo-order-live-007','demo-prod-agua-gas',1),
    ('demo-order-live-008','demo-prod-cubano-clasico',1),
    ('demo-order-live-008','demo-prod-coca-zero',1),
    ('demo-order-unpaid-001','demo-prod-pastrami-bros',1),
    ('demo-order-unpaid-001','demo-prod-limonada-coco',1),
    ('demo-order-unpaid-002','demo-prod-combo-pastrami',2),
    ('demo-order-unpaid-002','demo-prod-cheesecake',1),
    ('demo-order-today-001','demo-prod-pastrami-bros',2),
    ('demo-order-today-001','demo-prod-coca-zero',2),
    ('demo-order-today-002','demo-prod-reuben',1),
    ('demo-order-today-002','demo-prod-club-colombia',2),
    ('demo-order-today-003','demo-prod-porchetta',2),
    ('demo-order-today-003','demo-prod-brownie',1),
    ('demo-order-today-004','demo-prod-cubano-clasico',1),
    ('demo-order-today-004','demo-prod-limonada-coco',1),
    ('demo-order-today-005','demo-prod-smash-doble',1),
    ('demo-order-today-005','demo-prod-cheesecake',1),
    ('demo-order-today-006','demo-prod-combo-pastrami',2),
    ('demo-order-today-006','demo-prod-agua-gas',1),
    ('demo-order-today-007','demo-prod-pollo-buffalo',1),
    ('demo-order-today-007','demo-prod-coca-zero',1),
    ('demo-order-today-008','demo-prod-reuben',1),
    ('demo-order-today-008','demo-prod-limonada-coco',1)
)
INSERT INTO order_items (order_id, product_id, qty, price_at_order)
SELECT i.order_id, i.product_id, i.qty, p.price
FROM explicit_items i
JOIN products p ON p.id = i.product_id;

-- Items generados para historico actual.
WITH generated AS (
  SELECT
    'demo-order-hist-' || lpad(g::text, 3, '0') AS order_id,
    (ARRAY[
      'demo-prod-pastrami-bros','demo-prod-cubano-clasico','demo-prod-porchetta',
      'demo-prod-reuben','demo-prod-pollo-buffalo','demo-prod-smash-doble',
      'demo-prod-combo-pastrami','demo-prod-combo-cubano'
    ])[(g - 1) % 8 + 1] AS main_product_id,
    (ARRAY['demo-prod-coca-zero','demo-prod-limonada-coco','demo-prod-club-colombia','demo-prod-agua-gas'])[(g - 1) % 4 + 1] AS drink_product_id,
    CASE WHEN g % 9 = 0 THEN 'demo-prod-brownie' ELSE NULL END AS dessert_product_id,
    CASE WHEN g % 5 = 0 THEN 2 ELSE 1 END AS main_qty
  FROM generate_series(1, 64) AS g
),
items AS (
  SELECT order_id, main_product_id AS product_id, main_qty AS qty FROM generated
  UNION ALL
  SELECT order_id, drink_product_id, 1 FROM generated
  UNION ALL
  SELECT order_id, dessert_product_id, 1 FROM generated WHERE dessert_product_id IS NOT NULL
)
INSERT INTO order_items (order_id, product_id, qty, price_at_order)
SELECT i.order_id, i.product_id, i.qty, p.price
FROM items i
JOIN products p ON p.id = i.product_id;

-- Items generados para periodo anterior.
WITH generated AS (
  SELECT
    'demo-order-prev-' || lpad(g::text, 3, '0') AS order_id,
    (ARRAY[
      'demo-prod-cubano-clasico','demo-prod-pollo-buffalo','demo-prod-pastrami-bros',
      'demo-prod-reuben','demo-prod-combo-cubano','demo-prod-smash-doble'
    ])[(g - 1) % 6 + 1] AS main_product_id,
    (ARRAY['demo-prod-coca-zero','demo-prod-agua-gas','demo-prod-limonada-coco'])[(g - 1) % 3 + 1] AS drink_product_id
  FROM generate_series(1, 38) AS g
),
items AS (
  SELECT order_id, main_product_id AS product_id, 1 AS qty FROM generated
  UNION ALL
  SELECT order_id, drink_product_id, 1 FROM generated
)
INSERT INTO order_items (order_id, product_id, qty, price_at_order)
SELECT i.order_id, i.product_id, i.qty, p.price
FROM items i
JOIN products p ON p.id = i.product_id;

-- Refrescar contador visual de vendidos en catalogo.
UPDATE products p
SET sold = s.qty
FROM (
  SELECT product_id, sum(qty)::integer AS qty
  FROM order_items
  WHERE product_id LIKE 'demo-prod-%'
  GROUP BY product_id
) s
WHERE p.id = s.product_id;

-- ---------------------------------------------------------------------------
-- Chats y mensajes de WhatsApp.
-- ---------------------------------------------------------------------------
WITH rows(id, customer_id, status, unread, last, minutes_ago, flow_state) AS (
  VALUES
    ('demo-chat-001','demo-customer-002','human',2,'No me llego el codigo de Wompi, me ayudas?',4,'{"step":"link_enviado","orderId":"demo-order-unpaid-002"}'::jsonb),
    ('demo-chat-002','demo-customer-011','pending',1,'Hola, quiero hacer un pedido grande para la oficina',8,'{"step":"menu"}'::jsonb),
    ('demo-chat-003','demo-customer-001','bot',0,'Gracias, llego perfecto. Ya les deje resena.',13,'{"step":"postventa"}'::jsonb),
    ('demo-chat-004','demo-customer-003','bot',0,'Listo, quedo pendiente del pedido.',19,'{"step":"link_enviado","orderId":"demo-order-live-003"}'::jsonb),
    ('demo-chat-005','demo-customer-010','human',1,'El domiciliario esta cerca?',23,'{"step":"pedido_en_curso"}'::jsonb),
    ('demo-chat-006','demo-customer-013','bot',0,'Pague por PSE, quedo atento.',31,'{"step":"link_enviado","orderId":"demo-order-unpaid-002"}'::jsonb),
    ('demo-chat-007','demo-customer-014','bot',0,'Sin pepinillos porfa',37,'{"step":"link_enviado"}'::jsonb),
    ('demo-chat-008','demo-customer-017','pending',3,'Te mando pantallazo de la resena para el brownie',44,'{"step":"postventa_resena"}'::jsonb),
    ('demo-chat-009','demo-customer-006','bot',0,'Confirmado, misma direccion de siempre.',52,'{"step":"confirmar_recurrente"}'::jsonb),
    ('demo-chat-010','demo-customer-015','bot',0,'Quiero dos combos para Envigado.',61,'{"step":"direccion_zona"}'::jsonb),
    ('demo-chat-011','demo-customer-005','bot',0,'Estoy mirando la carta en el link.',74,'{"step":"link_enviado"}'::jsonb),
    ('demo-chat-012','demo-customer-016','human',1,'Aceptan pago contraentrega?',88,'{"step":"humano"}'::jsonb)
),
prepared AS (
  SELECT
    r.*,
    c.name,
    c.phone,
    c.zone_id,
    now() - make_interval(mins => r.minutes_ago) AS last_at
  FROM rows r
  JOIN customers c ON c.id = r.customer_id
)
INSERT INTO chats (
  id, customer_id, name, phone, last, time, unread, status, zone_id,
  prev_orders, avg_ticket, last_message_at, flow_state, flow_updated_at
)
SELECT
  id,
  customer_id,
  name,
  phone,
  last,
  to_char(last_at AT TIME ZONE 'America/Bogota', 'HH24:MI'),
  unread,
  status::chat_status,
  zone_id,
  0,
  0,
  last_at,
  flow_state,
  last_at
FROM prepared;

WITH rows(chat_id, direction, body, minutes_ago) AS (
  VALUES
    ('demo-chat-001','bot','Te envie el link de pago de tu pedido. Si Wompi se demora, puedo pasarte con alguien del equipo.',12),
    ('demo-chat-001','in','No me llego el codigo de Wompi, me ayudas?',5),
    ('demo-chat-001','out','Claro, Andres. Estoy revisando el pago y te acompano por aca.',3),
    ('demo-chat-002','in','Hola, quiero hacer un pedido grande para la oficina',9),
    ('demo-chat-002','bot','De una. Decime cuantas personas son y si prefieren combos o sandwiches sueltos.',8),
    ('demo-chat-003','bot','Gracias por pedir con Bros and Subs. Como te fue con el pedido?',35),
    ('demo-chat-003','in','Todo delicioso, ya les deje resena de 5 estrellas.',14),
    ('demo-chat-003','bot','Que nota, Maria. Te guardamos un brownie de cortesia para la proxima compra.',13),
    ('demo-chat-004','in','Listo, quedo pendiente del pedido.',20),
    ('demo-chat-004','bot','Tu pedido ya esta en cocina. Te avisamos cuando salga a ruta.',19),
    ('demo-chat-005','in','El domiciliario esta cerca?',24),
    ('demo-chat-005','out','Si, Mateo. Va por la 33 y llega en unos 8 minutos.',22),
    ('demo-chat-006','in','Pague por PSE, quedo atento.',32),
    ('demo-chat-006','bot','Perfecto. Apenas el banco confirme, cocina recibe tu orden automaticamente.',31),
    ('demo-chat-007','in','Sin pepinillos porfa',39),
    ('demo-chat-007','bot','Anotado: sin pepinillos. Gracias por confirmar.',37),
    ('demo-chat-008','in','Te mando pantallazo de la resena para el brownie',46),
    ('demo-chat-008','bot','Gracias, Antonia. Un humano revisa la captura y te confirma el regalo.',44),
    ('demo-chat-009','bot','Hola Miguel, pedimos a la misma direccion de Laureles?',56),
    ('demo-chat-009','in','Confirmado, misma direccion de siempre.',53),
    ('demo-chat-010','in','Quiero dos combos para Envigado.',63),
    ('demo-chat-010','bot','Perfecto. Envigado tiene domicilio de $6.500. Te envio link de pago.',61),
    ('demo-chat-011','bot','Aqui tienes la carta y el checkout para terminar tu pedido.',76),
    ('demo-chat-011','in','Estoy mirando la carta en el link.',74),
    ('demo-chat-012','in','Aceptan pago contraentrega?',90),
    ('demo-chat-012','out','Si, Nicolas. Te lo dejo marcado como dataphone contraentrega.',88)
)
INSERT INTO messages (chat_id, direction, body, created_at, delivered_at, read_at)
SELECT
  chat_id,
  direction::message_direction,
  body,
  now() - make_interval(mins => minutes_ago),
  CASE WHEN direction IN ('bot','out') THEN now() - make_interval(mins => greatest(minutes_ago - 1, 1)) END,
  CASE WHEN direction IN ('bot','out') THEN now() - make_interval(mins => greatest(minutes_ago - 2, 1)) END
FROM rows;

-- ---------------------------------------------------------------------------
-- Encuestas, rewards y leads.
-- ---------------------------------------------------------------------------
WITH rows(id, order_id, rating, comment, days_ago) AS (
  VALUES
    ('demo-survey-001','demo-order-today-001',5,'El pastrami llego caliente y muy rapido.',0),
    ('demo-survey-002','demo-order-today-002',5,'Excelente empaque, todo separado.',0),
    ('demo-survey-003','demo-order-today-004',4,'Muy rico, solo faltaron servilletas.',0),
    ('demo-survey-004','demo-order-hist-006',3,'Se demoro mas de lo esperado.',4),
    ('demo-survey-005','demo-order-hist-011',5,'El mejor cubano de Medellin.',7),
    ('demo-survey-006','demo-order-hist-018',2,'La bebida llego tibia.',11),
    ('demo-survey-007','demo-order-hist-025',5,'Volveria a pedir sin pensarlo.',16),
    ('demo-survey-008','demo-order-hist-032',4,'Muy buen sabor y buena porcion.',22)
)
INSERT INTO order_surveys (
  id, order_id, phone, rating, comment, sent_at, responded_at, created_at
)
SELECT
  r.id,
  r.order_id,
  o.phone,
  r.rating,
  r.comment,
  o.delivered_at + interval '30 minutes',
  o.delivered_at + interval '48 minutes',
  o.delivered_at
FROM rows r
JOIN orders o ON o.id = r.order_id;

INSERT INTO rewards (
  id, phone, customer_id, kind, status, order_id_origen, screenshot_url,
  granted_by, granted_at, redeemed_at, redeemed_order_id, expires_at, notes, created_at
) VALUES
  (
    'demo-reward-001', '+573223334455', 'demo-customer-017', 'postre_resena', 'pendiente',
    'demo-order-today-002', 'https://loremflickr.com/800/1000/google,review?lock=601',
    NULL, NULL, NULL, NULL, now() + interval '30 days',
    'Cliente envio pantallazo por WhatsApp; pendiente de validar en Maps.',
    now() - interval '45 minutes'
  ),
  (
    'demo-reward-002', '+573126451209', 'demo-customer-001', 'postre_resena', 'otorgado',
    'demo-order-today-001', 'https://loremflickr.com/800/1000/review,stars?lock=602',
    'admin@skipfee.co', now() - interval '20 minutes', NULL, NULL, now() + interval '30 days',
    'Aprobado para canjear brownie de cortesia.',
    now() - interval '35 minutes'
  ),
  (
    'demo-reward-003', '+573205580033', 'demo-customer-003', 'postre_resena', 'canjeado',
    'demo-order-hist-011', 'https://loremflickr.com/800/1000/review,restaurant?lock=603',
    'admin@skipfee.co', now() - interval '8 days', now() - interval '2 days',
    'demo-order-hist-004', now() + interval '22 days',
    'Canjeado automaticamente en checkout.',
    now() - interval '9 days'
  );

INSERT INTO leads (
  created_at, whatsapp, business_name, contact_name, phone, email, contact_channel,
  plan, orders_volume, peak_hours, est_loss, city, current_apps, cuisine_type,
  estado, source, user_agent
) VALUES
  (now() - interval '2 hours', '+573004001122', 'La Burguesia Medellin', 'Camilo Rios', '+573004001122', 'camilo@laburguesia.co', 'whatsapp', 'demo-video', '60-100', 'almuerzo,noche', '3M-6M', 'Medellin', 'Rappi, DiDi Food', 'Hamburguesas', 'calificado', 'demo-dashboard-seed', 'demo-seed'),
  (now() - interval '1 day', '+573114441010', 'Arepas Dona Gloria', 'Gloria Montoya', '+573114441010', 'gloria@example.com', 'llamada', 'demo-video', '30-60', 'desayuno,noche', '1M-3M', 'Envigado', 'Ninguna', 'Comida tipica', 'calificado', 'demo-dashboard-seed', 'demo-seed'),
  (now() - interval '3 days', '+573203330909', 'Sushi Manila', 'Sara Gomez', '+573203330909', 'sara@sushimanila.co', 'email', 'demo-video', '+100', 'noche', '+6M', 'Medellin', 'Rappi', 'Sushi', 'parcial', 'demo-dashboard-seed', 'demo-seed');

WITH rows (key, content, enabled, updated_at, updated_by) AS (
  VALUES
  ('saludo.nuevo', '{"body":"Hola {{nombre}}, soy el bot de Bros and Subs. Te ayudo a pedir por WhatsApp sin filas y sin enredos."}'::jsonb, true, now(), 'demo-dashboard-seed'),
  ('menu.pedir', '{"body":"Que hacemos hoy?","buttons":[{"id":"menu_pedir","title":"Hacer pedido"}]}'::jsonb, true, now(), 'demo-dashboard-seed'),
  ('notif.cocina', '{"body":"Tu pedido {{numero}} ya esta en cocina. Estamos armando todo para que salga perfecto."}'::jsonb, true, now(), 'demo-dashboard-seed'),
  ('postventa.encuesta', '{"body":"Como te fue con tu pedido {{numero}}? Responde de 1 a 5 y nos ayudas a mejorar."}'::jsonb, true, now(), 'demo-dashboard-seed'),
  ('keywords.humano', '{"words":["humano","asesor","ayuda","operador","hablar con alguien","soporte"]}'::jsonb, true, now(), 'demo-dashboard-seed')
)
INSERT INTO bot_messages (key, content, enabled, updated_at, updated_by)
SELECT r.key, r.content, r.enabled, r.updated_at, r.updated_by
FROM rows r
WHERE NOT EXISTS (
  SELECT 1 FROM bot_messages bm WHERE bm.key = r.key
);

-- Refrescar metricas antiguas de customer para cualquier vista directa;
-- los endpoints actuales calculan esto al vuelo desde orders.
WITH stats AS (
  SELECT
    customer_id,
    count(*)::integer AS pedidos,
    round(avg(total))::integer AS ticket,
    max(created_at)::text AS ultimo
  FROM orders
  WHERE id LIKE 'demo-order-%'
    AND status = 'entregado'
  GROUP BY customer_id
)
UPDATE customers c
SET
  pedidos = stats.pedidos,
  ticket = stats.ticket,
  ultimo = stats.ultimo,
  tag = CASE
    WHEN stats.pedidos > 10 THEN 'VIP'::customer_tag
    WHEN stats.pedidos >= 2 THEN 'Recurrente'::customer_tag
    ELSE 'Nuevo'::customer_tag
  END
FROM stats
WHERE c.id = stats.customer_id;

-- Restaurar defaults originales de company_id (si M2 los tenia).
DO $$
DECLARE
  defaults jsonb := COALESCE(NULLIF(current_setting('skipfee_demo.company_defaults', true), '')::jsonb, '{}'::jsonb);
  r record;
BEGIN
  FOR r IN
    SELECT
      key AS table_name,
      value ->> 'default_expr' AS default_expr
    FROM jsonb_each(defaults)
  LOOP
    IF r.default_expr IS NULL OR r.default_expr = '' THEN
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN company_id DROP DEFAULT',
        r.table_name
      );
    ELSE
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN company_id SET DEFAULT %s',
        r.table_name,
        r.default_expr
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

-- Bros and Subs · settings + seed de catálogo
-- Idempotente: usa ON CONFLICT DO NOTHING para que se pueda correr varias veces sin error.

-- =========================================================================
-- Tabla settings — 1 sola fila (id=1) con la config global del negocio
-- =========================================================================

CREATE TABLE IF NOT EXISTS settings (
  id                 integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  open_hour          text    NOT NULL DEFAULT '11:00',
  close_hour         text    NOT NULL DEFAULT '22:00',
  open_days          text[]  NOT NULL DEFAULT '{mon,tue,wed,thu,fri,sat,sun}',
  peak_start         text,
  peak_end           text,
  peak_surcharge     integer NOT NULL DEFAULT 0,
  base_delivery_fee  integer NOT NULL DEFAULT 4500,
  reminder_minutes   integer NOT NULL DEFAULT 5,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read" ON settings FOR SELECT USING (true);

-- Fila única default
INSERT INTO settings (
  id, open_hour, close_hour, open_days,
  peak_start, peak_end, peak_surcharge,
  base_delivery_fee, reminder_minutes
)
VALUES (
  1, '11:00', '22:00', '{mon,tue,wed,thu,fri,sat,sun}',
  '12:00', '14:00', 1500,
  4500, 5
)
ON CONFLICT (id) DO NOTHING;

-- =========================================================================
-- Seed: zones (4 zonas de Medellín del mock data.ts)
-- =========================================================================

INSERT INTO zones (id, name, tarifa, recargo, color, lat, lng) VALUES
  ('poblado',  'El Poblado', 4500, 1500, '#E85D04', 6.2087, -75.5658),
  ('envigado', 'Envigado',   5500, 2000, '#606C38', 6.1696, -75.5921),
  ('laureles', 'Laureles',   5000, 1500, '#5E6AD2', 6.2486, -75.5933),
  ('fatima',   'Fátima',     6000, 2000, '#A16207', 6.2364, -75.6028)
ON CONFLICT (id) DO NOTHING;

-- =========================================================================
-- Seed: products (15 productos del mock)
-- =========================================================================

INSERT INTO products (id, name, price, cat, sold, available, img) VALUES
  ('p01', 'Pastrami Bros',          28000, 'Sándwiches', 142, true,  'https://loremflickr.com/480/360/pastrami,sandwich,deli?lock=21'),
  ('p02', 'Porchetta Italiana',     32000, 'Sándwiches', 98,  true,  'https://loremflickr.com/480/360/porchetta,sandwich?lock=42'),
  ('p03', 'Cubano Clásico',         26000, 'Sándwiches', 117, true,  'https://loremflickr.com/480/360/cuban,sandwich,pressed?lock=11'),
  ('p04', 'Reuben de Brisket',      30000, 'Sándwiches', 76,  true,  'https://loremflickr.com/480/360/reuben,sandwich,brisket?lock=33'),
  ('p05', 'Pollo Buffalo',          24000, 'Sándwiches', 64,  true,  'https://loremflickr.com/480/360/buffalo,chicken,sandwich?lock=55'),
  ('p06', 'Smash Burger Doble',     27000, 'Sándwiches', 89,  true,  'https://loremflickr.com/480/360/smash,burger,cheese?lock=77'),
  ('p07', 'Veggie Bros',            22000, 'Sándwiches', 31,  false, 'https://loremflickr.com/480/360/veggie,sandwich,grilled?lock=88'),
  ('p08', 'Coca-Cola Zero 400ml',    6500, 'Bebidas',    188, true,  'https://loremflickr.com/480/360/coca,cola,can?lock=14'),
  ('p09', 'Limonada de Coco',        8500, 'Bebidas',    72,  true,  'https://loremflickr.com/480/360/lemonade,coconut,drink?lock=27'),
  ('p10', 'Cerveza Club Colombia',   8000, 'Bebidas',    104, true,  'https://loremflickr.com/480/360/beer,bottle,lager?lock=63'),
  ('p11', 'Agua con gas',            5500, 'Bebidas',    45,  true,  'https://loremflickr.com/480/360/sparkling,water,bottle?lock=91'),
  ('p12', 'Brownie con helado',     12000, 'Postres',    52,  true,  'https://loremflickr.com/480/360/brownie,icecream,chocolate?lock=18'),
  ('p13', 'Cheesecake fresa',       11000, 'Postres',    39,  true,  'https://loremflickr.com/480/360/cheesecake,strawberry?lock=24'),
  ('p14', 'Combo Pastrami + Coca',  32000, 'Combos',     81,  true,  'https://loremflickr.com/480/360/sandwich,soda,combo?lock=36'),
  ('p15', 'Combo Cubano + Cerveza', 31000, 'Combos',     58,  true,  'https://loremflickr.com/480/360/sandwich,beer,combo?lock=48')
ON CONFLICT (id) DO NOTHING;

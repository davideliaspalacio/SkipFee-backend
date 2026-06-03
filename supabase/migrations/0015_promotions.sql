-- Sistema de promociones automáticas.
--
-- Dos tipos (sin cupones por ahora):
--   * 'product'  — descuento sobre productos específicos del carrito.
--   * 'weekday'  — descuento que aplica solo ciertos días/horas de la semana,
--                  opcionalmente acotado a productos específicos.
--
-- Reglas:
--   * Todas son AUTOMÁTICAS: el backend las resuelve en cada recálculo del
--     carrito (PUT /api/checkout/:id/cart). No hay códigos de cupón.
--   * El descuento aplica SOLO sobre productos (subtotal). Nunca toca el
--     domicilio (peakSurcharge ni base_delivery_fee).
--   * Si hay varias activas y aplicables al mismo carrito, gana la que
--     produzca el descuento más alto (resolución en `lib/checkout/promotions`).
--
-- La columna `config jsonb` guarda parámetros específicos por kind:
--   kind='product':  { "product_ids": ["p01","p07"] }
--   kind='weekday':  { "weekdays": [1,3,5],            -- 0=dom, 6=sáb (getDay JS)
--                      "starts_hhmm": "12:00",         -- opcional
--                      "ends_hhmm":   "23:00",         -- opcional
--                      "product_ids": ["p01"] }        -- opcional (limita a productos)

CREATE TABLE promotions (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  kind            text NOT NULL CHECK (kind IN ('product','weekday')),
  name            text NOT NULL,
  description     text,
  -- percent: discount_value = % (1-100) sobre subtotal de items elegibles.
  -- fixed:   discount_value = COP fijo restado del subtotal de elegibles.
  -- free_item:    descuenta el precio del item elegible MÁS BARATO presente
  --               (1 unidad). discount_value se ignora.
  -- two_for_one:  por cada par de unidades elegibles, descuenta 1. p.ej.
  --               4 unidades → descuenta 2. discount_value se ignora.
  discount_type   text NOT NULL CHECK (discount_type IN ('percent','fixed','free_item','two_for_one')),
  discount_value  integer NOT NULL DEFAULT 0,
  -- Mínimo de subtotal (en COP) para que aplique. 0 = sin mínimo.
  min_subtotal    integer NOT NULL DEFAULT 0,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  active          boolean NOT NULL DEFAULT true,
  -- Programación opcional. NULL = sin restricción de calendario.
  starts_at       timestamptz,
  ends_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX promotions_active_idx ON promotions(active) WHERE active = true;

-- Snapshot del descuento aplicado al pedido. La fuente de verdad de cuánto
-- se le cobró al cliente sigue siendo `orders.total`, pero guardamos
-- `discount` y `promo_id` para auditoría/reportes.
ALTER TABLE orders
  ADD COLUMN promo_id text REFERENCES promotions(id),
  ADD COLUMN discount integer NOT NULL DEFAULT 0;

-- Trigger para mantener updated_at.
CREATE OR REPLACE FUNCTION promotions_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER promotions_updated_at_trg
  BEFORE UPDATE ON promotions
  FOR EACH ROW EXECUTE FUNCTION promotions_touch_updated_at();

-- RLS: solo el backend (service_role) puede tocar. El storefront lee vía
-- endpoints públicos /api/promotions/active, no directo desde Supabase.
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;

-- Bros and Subs · Wompi (Widget Checkout Web) — columnas en orders.
--
-- Con el Widget oficial, NO tenemos múltiples intentos persistidos en una tabla
-- aparte: el Widget maneja sus propios reintentos en el browser y el backend
-- solo recibe el evento final vía webhook (verificado por firma).
--
-- Lo único que persistimos para auditar / mostrar al cliente:
--  - `wompi_tx_id`         : el id de Wompi (lo devuelve la respuesta del
--                            widget y el webhook). Útil para soporte y para
--                            disparar la idempotencia del webhook.
--  - `wompi_status_message`: lo que reporta Wompi cuando el pago falla
--                            (DECLINED/ERROR). Se muestra al cliente en el
--                            mensaje de WhatsApp "tu pago no se procesó".

ALTER TABLE orders ADD COLUMN IF NOT EXISTS wompi_tx_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS wompi_status_message text;

-- Índice para que el webhook pueda hacer dedupe por wompi_tx_id de forma
-- barata (el webhook se procesa varias veces si Wompi reintenta).
CREATE INDEX IF NOT EXISTS orders_wompi_tx_id_idx ON orders(wompi_tx_id)
  WHERE wompi_tx_id IS NOT NULL;

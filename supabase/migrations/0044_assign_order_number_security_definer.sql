-- SkipFee · Numeración de pedidos segura bajo RLS
-- =========================================================================
-- El trigger de numeración actualiza `companies.next_order_number`. Cuando un
-- pedido se crea desde rutas autenticadas con RLS, esa actualización puede
-- quedar bloqueada por policies de `companies` y terminar con
-- `orders.order_number = null`. SECURITY DEFINER permite que el trigger haga
-- solo esa operación interna sin relajar las policies de la tabla.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.assign_order_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.order_number IS NULL THEN
    UPDATE public.companies
       SET next_order_number = next_order_number + 1
     WHERE id = NEW.company_id
    RETURNING next_order_number - 1 INTO NEW.order_number;
  END IF;

  IF NEW.order_number IS NULL THEN
    RAISE EXCEPTION 'No se pudo asignar order_number para company_id %', NEW.company_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_order_number ON public.orders;

CREATE TRIGGER trg_assign_order_number
  BEFORE INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_order_number();

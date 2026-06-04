-- Bros and Subs · ventana de visibilidad de pedidos entregados en el kanban
--
-- Sin esta ventana, el kanban devolvía entregados sin tope temporal, ordenados
-- por created_at DESC con limit 200. En un negocio activo esos 200 slots se
-- llenan rápido con entregados viejos y empujan afuera pedidos realmente
-- activos: bug de correctness, no solo de UX.
--
-- La ventana se aplica solo a la columna "Entregado" del kanban: las otras
-- columnas (nuevo/pagado/cocina/empacado/ruta) siguen sin tope. Se usa una
-- ventana rodante (no "hoy") para no borrar el trabajo del turno cuando cruza
-- la medianoche.
--
-- 8 h cubre un turno típico 11–22 h con margen para revisar el cierre. Se puede
-- editar desde Configuración → Horarios.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS delivered_window_hours integer NOT NULL DEFAULT 8
  CHECK (delivered_window_hours BETWEEN 1 AND 72);

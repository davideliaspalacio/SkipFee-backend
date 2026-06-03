/**
 * Helpers compartidos para métricas de pedidos.
 *
 * Mismas definiciones que usa /api/dashboard/today, extraídas acá para que
 * endpoints más livianos (ej. /api/orders/stats para el header del kanban)
 * no dupliquen lógica de "qué cuenta como activo" o "cuándo empieza hoy".
 */

/** Estados que cuentan como "pedido activo" — sigue moviéndose por el kanban. */
export const ACTIVE_STATUSES: readonly string[] = [
  'nuevo',
  'pagado',
  'cocina',
  'empacado',
  'ruta',
];

/**
 * Devuelve un Date UTC equivalente a las 00:00 de Bogotá del día actual.
 * Bogotá es UTC-5 todo el año (no usa DST), así que el offset es fijo.
 */
export function startOfTodayInBogota(): Date {
  const now = new Date();
  const bogotaNow = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  const y = bogotaNow.getUTCFullYear();
  const m = bogotaNow.getUTCMonth();
  const d = bogotaNow.getUTCDate();
  return new Date(Date.UTC(y, m, d, 5, 0, 0));
}

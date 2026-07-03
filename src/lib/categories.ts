/**
 * Orden de categorías de producto.
 *
 * El orden canónico lo define el restaurante en Configuración → Categorías y
 * vive en `settings.categories` (text[], por empresa). Todo consumidor que
 * agrupe o liste por categoría (tienda, bot, catálogo público) debe ordenar
 * con este comparador en vez de alfabéticamente.
 */

/**
 * Comparador de nombres de categoría según el orden configurado. Categorías
 * que no están en la lista van al final, preservando su orden de aparición
 * (sort estable).
 */
export function compareCategories(order: readonly string[]): (a: string, b: string) => number {
  const rank = new Map(order.map((cat, i) => [cat, i]));
  return (a, b) => (rank.get(a) ?? order.length) - (rank.get(b) ?? order.length);
}

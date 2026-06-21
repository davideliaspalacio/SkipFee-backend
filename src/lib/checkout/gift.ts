import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Postre de regalo (Tarea 3) como LÍNEA del carrito de la tienda.
 *
 * Hay regalo si el cliente tiene un reward 'otorgado' vigente Y `settings`
 * tiene un `review_gift_product_id` que apunta a un producto existente. La línea
 * va a precio 0 y marcada con `gift: true` para que el storefront la pinte como
 * "Gratis" y el cliente no la pueda editar.
 *
 * Es una línea CALCULADA: no se persiste en `order_items` mientras el pedido es
 * borrador (así no se mezcla con el carrito que edita el cliente). El order_item
 * real lo inserta `redeemRewardForOrder` cuando el pedido entra al kanban (estado
 * 'nuevo') o al pagar, para que la cocina lo vea como un ítem más.
 */
export interface GiftCartLine {
  productId: string;
  name: string;
  qty: number;
  price: number;
  lineTotal: number;
  gift: true;
}

/**
 * Multi-empresa: `companyId` (opcional) scopea rewards/settings/products a la
 * empresa del pedido para no cruzar datos. Cuando se omite (callers legacy aún
 * sin migrar) cae al comportamiento single-tenant (sin filtro de empresa;
 * `settings` por `id=1`).
 */
export async function giftCartLine(
  sb: SupabaseClient,
  phone: string,
  nowIso: string = new Date().toISOString(),
  companyId?: string,
): Promise<GiftCartLine | null> {
  // ¿Reward 'otorgado' vigente del cliente (de ESTA empresa)?
  let rewardsQuery = sb
    .from('rewards')
    .select('id')
    .eq('phone', phone)
    .eq('status', 'otorgado')
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`);
  if (companyId) rewardsQuery = rewardsQuery.eq('company_id', companyId);
  const { data: rewards } = await rewardsQuery.limit(1);
  if (!rewards || rewards.length === 0) return null;

  // ¿Producto de regalo configurado en Configuración → Reseñas?
  let settingsQuery = sb.from('settings').select('review_gift_product_id');
  settingsQuery = companyId ? settingsQuery.eq('company_id', companyId) : settingsQuery.eq('id', 1);
  const { data: settings } = await settingsQuery.maybeSingle();
  const productId = (settings as { review_gift_product_id?: string | null } | null)?.review_gift_product_id;
  if (!productId) return null;

  // El producto debe existir y NO estar archivado (un producto archivado
  // ya no se entrega como regalo aunque siga vinculado en settings).
  let productQuery = sb
    .from('products')
    .select('id, name, archived')
    .eq('id', productId);
  if (companyId) productQuery = productQuery.eq('company_id', companyId);
  const { data: product } = await productQuery.maybeSingle();
  if (!product || (product as { archived?: boolean }).archived) return null;

  return {
    productId: (product as { id: string }).id,
    name: (product as { name: string }).name,
    qty: 1,
    price: 0,
    lineTotal: 0,
    gift: true,
  };
}

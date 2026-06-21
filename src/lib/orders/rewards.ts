import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Canje del cupón de postre (Tarea 3).
 *
 * Cuando un pedido se PAGA, si el cliente tiene un reward 'otorgado' vigente lo
 * marca como 'canjeado' y deja constancia en la nota del pedido para que cocina
 * incluya el regalo. No agrega un SKU al carrito (el postre es físico, lo pone
 * cocina). Idempotente por pedido: si ya se canjeó algo en este pedido, no hace
 * nada. No lanza: cualquier fallo se loguea (el pago ya se aplicó).
 */
export async function redeemRewardForOrder(opts: {
  sb: SupabaseClient;
  orderId: string;
  phone: string;
  /**
   * Empresa del pedido. Multi-empresa: cuando se pasa, todo (rewards, settings,
   * order_item de regalo) se scopea a esa empresa. Opcional para no romper las
   * rutas de sistema aún sin migrar (caen al comportamiento legacy de la empresa
   * por defecto, cuya fila settings conserva id=1). TODO: volver requerido cuando
   * webhooks/wompi y orders/[id]/status estén migrados.
   */
  companyId?: string;
}): Promise<{ redeemed: boolean }> {
  const { sb, orderId, phone, companyId } = opts;
  const nowIso = new Date().toISOString();

  try {
    // Idempotencia: ¿ya se canjeó un cupón en este pedido?
    let alreadyQuery = sb.from('rewards').select('id').eq('redeemed_order_id', orderId);
    if (companyId) alreadyQuery = alreadyQuery.eq('company_id', companyId);
    const { data: already } = await alreadyQuery.limit(1);
    if (already && already.length > 0) return { redeemed: false };

    // Cupón 'otorgado' vigente más antiguo del cliente (de ESTA empresa).
    let rewardQuery = sb
      .from('rewards')
      .select('id')
      .eq('phone', phone)
      .eq('status', 'otorgado')
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`);
    if (companyId) rewardQuery = rewardQuery.eq('company_id', companyId);
    const { data: rows } = await rewardQuery.order('created_at', { ascending: true }).limit(1);
    const reward = rows?.[0] as { id: string } | undefined;
    if (!reward) return { redeemed: false };

    let settingsQuery = sb.from('settings').select('review_gift_name, review_gift_product_id');
    settingsQuery = companyId
      ? settingsQuery.eq('company_id', companyId)
      : settingsQuery.eq('id', 1);
    const { data: settings } = await settingsQuery.maybeSingle();
    const postre = (settings?.review_gift_name as string) ?? 'Postre';
    const giftProductId = (settings?.review_gift_product_id as string | null) ?? null;

    await sb
      .from('rewards')
      .update({ status: 'canjeado', redeemed_at: nowIso, redeemed_order_id: orderId })
      .eq('id', reward.id);

    // Si el regalo está vinculado a un producto real (categoría "Regalo"), lo
    // agregamos como order_item a $0 → la cocina lo ve en el kanban como un ítem
    // más del pedido. Idempotente por el guard de redeemed_order_id de arriba.
    if (giftProductId) {
      await sb.from('order_items').insert({
        order_id: orderId,
        product_id: giftProductId,
        qty: 1,
        price_at_order: 0,
        ...(companyId ? { company_id: companyId } : {}),
      });
    }

    // Constancia en la nota del pedido (append, sin pisar la del cliente).
    const { data: order } = await sb.from('orders').select('note').eq('id', orderId).maybeSingle();
    const prev = ((order?.note as string | null) ?? '').trim();
    const giftNote = `🍰 ${postre} de regalo (reseña)`;
    const note = prev ? `${prev} · ${giftNote}` : giftNote;
    await sb.from('orders').update({ note }).eq('id', orderId);

    return { redeemed: true };
  } catch (err) {
    console.error('[redeemRewardForOrder] error', { orderId, err });
    return { redeemed: false };
  }
}

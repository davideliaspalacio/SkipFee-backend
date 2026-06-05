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
}): Promise<{ redeemed: boolean }> {
  const { sb, orderId, phone } = opts;
  const nowIso = new Date().toISOString();

  try {
    // Idempotencia: ¿ya se canjeó un cupón en este pedido?
    const { data: already } = await sb
      .from('rewards')
      .select('id')
      .eq('redeemed_order_id', orderId)
      .limit(1);
    if (already && already.length > 0) return { redeemed: false };

    // Cupón 'otorgado' vigente más antiguo del cliente.
    const { data: rows } = await sb
      .from('rewards')
      .select('id')
      .eq('phone', phone)
      .eq('status', 'otorgado')
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .order('created_at', { ascending: true })
      .limit(1);
    const reward = rows?.[0] as { id: string } | undefined;
    if (!reward) return { redeemed: false };

    const { data: settings } = await sb
      .from('settings')
      .select('review_gift_name')
      .eq('id', 1)
      .maybeSingle();
    const postre = (settings?.review_gift_name as string) ?? 'Postre';

    await sb
      .from('rewards')
      .update({ status: 'canjeado', redeemed_at: nowIso, redeemed_order_id: orderId })
      .eq('id', reward.id);

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

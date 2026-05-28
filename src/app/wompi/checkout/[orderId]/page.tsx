import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COP = (n: number) => '$' + new Intl.NumberFormat('es-CO').format(Math.round(n));

/**
 * Página mock de checkout. El bot envía al cliente:
 *   https://nuestra-app.com/wompi/checkout/<orderId>
 *
 * El cliente abre el link y ve esta página con sus items + total + 2 botones.
 * El "Aprobar" hace POST a /api/wompi/webhook simulando confirmación de Wompi.
 *
 * Cuando llegue Wompi real, esta página se reemplaza por una redirección
 * a checkout.wompi.co y el flujo de pago real.
 */
export default async function MockCheckout({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const sb = supabaseAdmin();

  const { data: order } = await sb
    .from('orders')
    .select(
      'id, status, total, address, phone, payment_method, items:order_items(qty, price_at_order, product:products(name))',
    )
    .eq('id', orderId)
    .single();

  if (!order) notFound();

  const items = (order.items ?? []).map(
    (i: { qty: number; price_at_order: number; product: { name: string } | { name: string }[] | null }) => ({
      qty: i.qty,
      price: i.price_at_order,
      name: Array.isArray(i.product) ? i.product[0]?.name : i.product?.name,
    }),
  );

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 480, margin: '40px auto', padding: 24 }}>
      <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 12, padding: 16, marginBottom: 24 }}>
        <strong style={{ color: '#9A3412' }}>⚠️ Mock de Wompi</strong>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: '#7C2D12' }}>
          Esta es una página de prueba. En producción te redirige a checkout.wompi.co con el flujo real.
        </p>
      </div>

      <h1 style={{ fontSize: 24, margin: '0 0 8px' }}>Pedido #{order.id.slice(0, 8).toUpperCase()}</h1>
      <p style={{ color: '#666', margin: '0 0 24px' }}>Estado: {order.status}</p>

      <h2 style={{ fontSize: 18, margin: '0 0 12px' }}>Detalles</h2>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px' }}>
        {items.map((it, idx) => (
          <li key={idx} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #eee' }}>
            <span>{it.qty}× {it.name ?? 'Item'}</span>
            <span>{COP(it.price * it.qty)}</span>
          </li>
        ))}
      </ul>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 20, fontWeight: 600, padding: '12px 0', borderTop: '2px solid #000' }}>
        <span>Total</span>
        <span>{COP(order.total)}</span>
      </div>

      <p style={{ color: '#666', fontSize: 14, margin: '24px 0 8px' }}>
        Dirección: {order.address}<br />
        Pago: {order.payment_method}
      </p>

      <form action="/api/wompi/webhook" method="POST" style={{ marginTop: 32, display: 'grid', gap: 12 }}>
        <input type="hidden" name="orderId" value={order.id} />
        <button
          type="submit"
          name="status"
          value="APPROVED"
          style={{ background: '#16A34A', color: 'white', border: 0, padding: '14px', borderRadius: 8, fontSize: 16, cursor: 'pointer' }}
        >
          ✅ Aprobar pago (simular)
        </button>
        <button
          type="submit"
          name="status"
          value="DECLINED"
          style={{ background: '#DC2626', color: 'white', border: 0, padding: '14px', borderRadius: 8, fontSize: 16, cursor: 'pointer' }}
        >
          ❌ Rechazar pago
        </button>
      </form>
    </main>
  );
}

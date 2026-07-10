import { simulateMarketplaceOrder, type MarketplaceProvider } from '@/lib/channels';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isMarketplaceProvider(provider: string): provider is MarketplaceProvider {
  return provider === 'rappi' || provider === 'didi';
}

/**
 * POST /api/<companyId>/channels/:provider/simulate-order
 * Crea un pedido fake de Rappi/DiDi que entra al kanban como pedido normalizado.
 */
export const POST = withTenant<{ companyId: string; provider: string }>(
  async (_request, ctx, params) => {
    if (!isMarketplaceProvider(params.provider)) {
      return Response.json(
        { ok: false, error: 'Solo Rappi y DiDi tienen simulador en esta fase' },
        { status: 400 },
      );
    }

    try {
      const result = await simulateMarketplaceOrder(ctx.db, ctx.company.id, params.provider);
      return Response.json({ ok: true, result }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'simulate order error';
      console.error('[channels simulate-order] error', err);
      return Response.json({ ok: false, error: message }, { status: 500 });
    }
  },
);

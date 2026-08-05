import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * Las dos URLs legacy de eventos de Wompi (las que quedaron registradas en el
 * panel del comercio antes de multi-empresa) deben seguir entrando al mismo
 * handler, resolviendo la empresa por defecto. Si se rompen, Wompi recibe 404
 * y el pago se pierde EN SILENCIO: no hay log ni fila en la BD que lo delate.
 */

const postForCompany = vi.fn(async () => Response.json({ ok: true }));

vi.mock('./[companyId]/route', () => ({
  POST: (...args: unknown[]) => postForCompany(...(args as [])),
}));

const req = {} as NextRequest;

beforeEach(() => {
  postForCompany.mockClear();
  delete process.env.WOMPI_LEGACY_COMPANY_SLUG;
  vi.resetModules();
});

async function slugUsado(): Promise<string> {
  const call = postForCompany.mock.calls[0] as unknown as [NextRequest, { params: Promise<{ companyId: string }> }];
  return (await call[1].params).companyId;
}

describe('rutas legacy del webhook de Wompi', () => {
  it('/api/webhooks/wompi delega en la empresa por defecto', async () => {
    const { POST } = await import('./route');
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(postForCompany).toHaveBeenCalledTimes(1);
    expect(await slugUsado()).toBe('bros-and-subs');
  });

  it('/api/wompi/webhook (la URL original) delega igual', async () => {
    const { POST } = await import('../../wompi/webhook/route');
    await POST(req);
    expect(postForCompany).toHaveBeenCalledTimes(1);
    expect(await slugUsado()).toBe('bros-and-subs');
  });

  it('WOMPI_LEGACY_COMPANY_SLUG cambia a qué empresa apuntan', async () => {
    process.env.WOMPI_LEGACY_COMPANY_SLUG = 'pizzeria-napoli';
    const { POST } = await import('./route');
    await POST(req);
    expect(await slugUsado()).toBe('pizzeria-napoli');
  });
});

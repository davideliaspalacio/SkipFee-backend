import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { makeSupabaseStub } from '@/lib/checkout/test-helpers';

let supabaseStub: ReturnType<typeof makeSupabaseStub>;
const orderUpdateCapture = vi.fn();
const chatUpdateCapture = vi.fn();
const sendTextMock = vi.fn();
const recordMessageMock = vi.fn();

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => supabaseStub.client,
}));
vi.mock('@/lib/kapso/client', () => ({
  sendText: (...args: unknown[]) => sendTextMock(...args),
}));
vi.mock('@/lib/messaging', () => ({
  recordMessage: (...args: unknown[]) => recordMessageMock(...args),
}));

import { POST } from './route';

const URL = 'http://localhost:3000/api/webhooks/wompi';
const SECRET = 'test_events_demo_secret_xxx';

/** Genera un evento Wompi válido con su checksum (mismo algoritmo que verifyWebhookSignature). */
function buildEvent(opts: {
  txId: string;
  status: 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR';
  amountInCents: number;
  reference: string;
  paymentMethodType?: string;
  statusMessage?: string;
  timestamp?: number;
}) {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const txn = {
    id: opts.txId,
    amount_in_cents: opts.amountInCents,
    reference: opts.reference,
    customer_email: 'cliente@test.com',
    currency: 'COP',
    payment_method_type: opts.paymentMethodType ?? 'CARD',
    status: opts.status,
    status_message: opts.statusMessage ?? null,
  };
  const concat =
    String(txn.id) + String(txn.status) + String(txn.amount_in_cents) + String(timestamp) + SECRET;
  const checksum = createHash('sha256').update(concat).digest('hex');
  return {
    event: 'transaction.updated',
    data: { transaction: txn },
    environment: 'test',
    signature: {
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
      checksum,
    },
    timestamp,
    sent_at: new Date(timestamp * 1000).toISOString(),
  };
}

function req(event: unknown, headers: Record<string, string> = {}) {
  return new Request(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(event),
  }) as never;
}

function tablesFor(orderRow: unknown) {
  return {
    orders: {
      single: orderRow,
      onUpdate: (payload: unknown) => {
        orderUpdateCapture(payload);
        return {};
      },
    },
    chats: {
      onUpdate: (payload: unknown) => {
        chatUpdateCapture(payload);
        return {};
      },
    },
  };
}

function borradorOrder(extra: Record<string, unknown> = {}) {
  return {
    id: 'o-uuid-1',
    status: 'borrador',
    phone: '573136913188',
    total: 60500, // COP (sin centavos), Wompi recibe 6_050_000
    wompi_tx_id: null,
    customer: { name: 'Ana Pérez' },
    ...extra,
  };
}

beforeEach(() => {
  process.env.WOMPI_EVENTS_SECRET = SECRET;
  orderUpdateCapture.mockReset();
  chatUpdateCapture.mockReset();
  sendTextMock.mockReset().mockResolvedValue({ messages: [{ id: 'wamid-1' }] });
  recordMessageMock.mockReset().mockResolvedValue({ chatId: 'wa:573136913188' });
});

describe('POST /api/webhooks/wompi', () => {
  it('APPROVED + firma válida + monto OK ⇒ marca pagado + side effects', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(borradorOrder()));
    const event = buildEvent({
      txId: '15068-1700000000-1',
      status: 'APPROVED',
      amountInCents: 6_050_000,
      reference: 'o-uuid-1',
    });
    const res = await POST(req(event));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.applied).toBe(true);
    expect(body.newStatus).toBe('pagado');

    // update setea status=pagado + wompi_tx_id + statusMessage limpio
    expect(orderUpdateCapture).toHaveBeenCalled();
    const upd = orderUpdateCapture.mock.calls[0][0];
    expect(upd.status).toBe('pagado');
    expect(upd.wompi_tx_id).toBe('15068-1700000000-1');

    // side effects (sin cambios respecto al mock)
    expect(sendTextMock).toHaveBeenCalledWith('573136913188', expect.stringContaining('pago recibido'));
    expect(chatUpdateCapture).toHaveBeenCalled();
    expect(chatUpdateCapture.mock.calls[0][0].flow_state.step).toBe('finalizado');
  });

  it('acepta header X-Event-Checksum como fuente del checksum (con body sin signature.checksum)', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(borradorOrder()));
    const event = buildEvent({
      txId: 't-2',
      status: 'APPROVED',
      amountInCents: 6_050_000,
      reference: 'o-uuid-1',
    });
    const headerChecksum = event.signature.checksum;
    const eventNoBodyChecksum = {
      ...event,
      signature: { properties: event.signature.properties },
    };
    const res = await POST(req(eventNoBodyChecksum, { 'x-event-checksum': headerChecksum }));
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toBe(true);
  });

  it('firma inválida ⇒ 401, no toca orden', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(borradorOrder()));
    const event = buildEvent({
      txId: 't-3',
      status: 'APPROVED',
      amountInCents: 6_050_000,
      reference: 'o-uuid-1',
    });
    event.signature.checksum = 'a'.repeat(64); // checksum manipulado
    const res = await POST(req(event));
    expect(res.status).toBe(401);
    expect(orderUpdateCapture).not.toHaveBeenCalled();
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('orden no encontrada ⇒ 200 con applied:false (NO 404 — Wompi reintentaría)', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(null));
    const event = buildEvent({
      txId: 't-4',
      status: 'APPROVED',
      amountInCents: 1000,
      reference: 'inexistente',
    });
    const res = await POST(req(event));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.reason).toMatch(/orden/i);
  });

  it('monto distinto al total ⇒ NO aprueba, applied:false', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(borradorOrder({ total: 60500 })));
    const event = buildEvent({
      txId: 't-5',
      status: 'APPROVED',
      amountInCents: 5_000_000, // ≠ 60500 * 100
      reference: 'o-uuid-1',
    });
    const res = await POST(req(event));
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.reason).toMatch(/monto|amount/i);
    expect(orderUpdateCapture).not.toHaveBeenCalled();
  });

  it('DECLINED ⇒ orden vuelve a borrador + guarda status_message + NO manda "pago recibido"', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(borradorOrder({ status: 'pendiente_pago' })));
    const event = buildEvent({
      txId: 't-6',
      status: 'DECLINED',
      amountInCents: 6_050_000,
      reference: 'o-uuid-1',
      statusMessage: 'Fondos insuficientes',
    });
    const res = await POST(req(event));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
    expect(body.newStatus).toBe('borrador');

    const upd = orderUpdateCapture.mock.calls[0][0];
    expect(upd.status).toBe('borrador');
    expect(upd.wompi_status_message).toBe('Fondos insuficientes');

    expect(sendTextMock).not.toHaveBeenCalled();
    expect(chatUpdateCapture).not.toHaveBeenCalled();
  });

  it('idempotente: si la orden ya tiene wompi_tx_id == event.transaction.id ⇒ no re-procesa', async () => {
    supabaseStub = makeSupabaseStub(
      tablesFor(borradorOrder({ status: 'pagado', wompi_tx_id: 't-7' })),
    );
    const event = buildEvent({
      txId: 't-7',
      status: 'APPROVED',
      amountInCents: 6_050_000,
      reference: 'o-uuid-1',
    });
    const res = await POST(req(event));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.reason).toMatch(/idempotent|ya|already/i);
    expect(orderUpdateCapture).not.toHaveBeenCalled();
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('orden en estado no-pagable (cocina/ruta) ⇒ applied:false, no toca', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(borradorOrder({ status: 'cocina' })));
    const event = buildEvent({
      txId: 't-8',
      status: 'APPROVED',
      amountInCents: 6_050_000,
      reference: 'o-uuid-1',
    });
    const res = await POST(req(event));
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.reason).toMatch(/status|estado/i);
    expect(orderUpdateCapture).not.toHaveBeenCalled();
  });

  it('currency != COP ⇒ NO aprueba', async () => {
    supabaseStub = makeSupabaseStub(tablesFor(borradorOrder()));
    const event = buildEvent({
      txId: 't-9',
      status: 'APPROVED',
      amountInCents: 6_050_000,
      reference: 'o-uuid-1',
    });
    event.data.transaction.currency = 'USD';
    // re-firmar con currency tampered no haría falta (la firma usa solo id+status+amount).
    const res = await POST(req(event));
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.reason).toMatch(/currency/i);
  });

  it('JSON inválido ⇒ 400', async () => {
    const malformed = new Request(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    }) as never;
    const res = await POST(malformed);
    expect(res.status).toBe(400);
  });
});

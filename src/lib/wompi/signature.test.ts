import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateIntegritySignature,
  verifyWebhookSignature,
  extractEventChecksum,
} from './signature';

describe('generateIntegritySignature', () => {
  const ORIG = process.env.WOMPI_INTEGRITY_SECRET;
  beforeEach(() => {
    process.env.WOMPI_INTEGRITY_SECRET = 'prod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6';
  });
  afterEach(() => {
    if (ORIG === undefined) delete process.env.WOMPI_INTEGRITY_SECRET;
    else process.env.WOMPI_INTEGRITY_SECRET = ORIG;
  });

  // Ejemplo EXACTO de la doc oficial:
  // https://docs.wompi.co/docs/colombia/widget-checkout-web/
  it('replica el ejemplo de la doc oficial (sin expiration)', () => {
    const sig = generateIntegritySignature({
      reference: 'sk8-438k4-xmxm392-sn2m',
      amountInCents: 2490000,
      currency: 'COP',
    });
    expect(sig).toBe('37c8407747e595535433ef8f6a811d853cd943046624a0ec04662b17bbf33bf5');
  });

  it('incluye expirationTime en el hash cuando se provee', () => {
    const a = generateIntegritySignature({
      reference: 'r1',
      amountInCents: 1000,
      currency: 'COP',
    });
    const b = generateIntegritySignature({
      reference: 'r1',
      amountInCents: 1000,
      currency: 'COP',
      expirationTime: '2026-06-09T20:28:50.000Z',
    });
    expect(a).not.toBe(b);
  });

  it('lanza si WOMPI_INTEGRITY_SECRET no está configurado', () => {
    delete process.env.WOMPI_INTEGRITY_SECRET;
    expect(() =>
      generateIntegritySignature({ reference: 'x', amountInCents: 1, currency: 'COP' }),
    ).toThrow(/WOMPI_INTEGRITY_SECRET/);
  });

  it('devuelve hex lowercase de 64 chars', () => {
    const sig = generateIntegritySignature({
      reference: 'abc',
      amountInCents: 100,
      currency: 'COP',
    });
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyWebhookSignature', () => {
  const ORIG = process.env.WOMPI_EVENTS_SECRET;
  beforeEach(() => {
    process.env.WOMPI_EVENTS_SECRET = 'prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z';
  });
  afterEach(() => {
    if (ORIG === undefined) delete process.env.WOMPI_EVENTS_SECRET;
    else process.env.WOMPI_EVENTS_SECRET = ORIG;
  });

  // Mismo SHAPE del ejemplo oficial de la doc (https://docs.wompi.co/docs/colombia/eventos/),
  // pero con el checksum REAL calculado del input dado (la doc tiene typo: el
  // checksum que muestra NO corresponde al input mostrado — verificado con sha256
  // puro de Node).
  //
  //   input  = "1234-1610641025-49201" + "APPROVED" + "4490000" + "1530291411"
  //          + "prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z"
  //   sha256 = 5a18ec5e8fdb7df463e9f94774cba8f583ba21bd04a09ceff2ea68a4bc0aefbe
  const officialEvent = {
    event: 'transaction.updated',
    data: {
      transaction: {
        id: '1234-1610641025-49201',
        amount_in_cents: 4490000,
        reference: 'MZQ3X2DE2SMX',
        customer_email: 'juan.perez@gmail.com',
        currency: 'COP',
        payment_method_type: 'NEQUI',
        status: 'APPROVED',
      },
    },
    environment: 'prod',
    signature: {
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
      checksum: '5a18ec5e8fdb7df463e9f94774cba8f583ba21bd04a09ceff2ea68a4bc0aefbe',
    },
    timestamp: 1530291411,
    sent_at: '2018-07-20T16:45:05.000Z',
  };

  it('valida el ejemplo oficial de la doc (algoritmo SHA256 de la doc)', () => {
    expect(verifyWebhookSignature(officialEvent)).toBe(true);
  });

  it('comparación es case-insensitive (acepta UPPERCASE como en la doc)', () => {
    const upper = {
      ...officialEvent,
      signature: {
        ...officialEvent.signature,
        checksum: officialEvent.signature.checksum.toUpperCase(),
      },
    };
    expect(verifyWebhookSignature(upper)).toBe(true);
  });

  it('acepta checksum por header (cuando el body NO lo trae)', () => {
    const noSig = { ...officialEvent, signature: { properties: officialEvent.signature.properties } };
    expect(verifyWebhookSignature(noSig, officialEvent.signature.checksum)).toBe(true);
  });

  it('rechaza si el checksum no coincide (manipulación del payload)', () => {
    const tampered = {
      ...officialEvent,
      data: { transaction: { ...officialEvent.data.transaction, amount_in_cents: 999 } },
    };
    expect(verifyWebhookSignature(tampered)).toBe(false);
  });

  it('rechaza si el secret está mal', () => {
    process.env.WOMPI_EVENTS_SECRET = 'wrong';
    expect(verifyWebhookSignature(officialEvent)).toBe(false);
  });

  it('lanza si WOMPI_EVENTS_SECRET no está configurado', () => {
    delete process.env.WOMPI_EVENTS_SECRET;
    expect(() => verifyWebhookSignature(officialEvent)).toThrow(/WOMPI_EVENTS_SECRET/);
  });

  it('rechaza si signature.properties está ausente y no se da header', () => {
    const noProps = { ...officialEvent, signature: undefined };
    expect(verifyWebhookSignature(noProps)).toBe(false);
  });

  it('soporta properties dinámicas (paths arbitrarios)', () => {
    process.env.WOMPI_EVENTS_SECRET = 'test-secret';
    const customProps = {
      data: { transaction: { id: 'tx1', status: 'APPROVED' } },
      timestamp: 100,
      signature: {
        properties: ['transaction.id', 'transaction.status'],
        // sha256("tx1" + "APPROVED" + "100" + "test-secret")
        checksum: '48b0fb9da563c8ca1f53510a049b4a39f423b61336bbc1179d52cfadaf60d3a9',
      },
    };
    expect(verifyWebhookSignature(customProps as never)).toBe(true);
  });
});

describe('extractEventChecksum', () => {
  it('devuelve el del header si está', () => {
    expect(extractEventChecksum({ signature: { checksum: 'a' } }, 'b')).toBe('b');
  });

  it('cae al body cuando header está ausente', () => {
    expect(extractEventChecksum({ signature: { checksum: 'a' } }, null)).toBe('a');
  });

  it('null si ninguno está', () => {
    expect(extractEventChecksum({}, null)).toBeNull();
  });
});

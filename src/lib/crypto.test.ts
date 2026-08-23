import { beforeEach, describe, expect, it } from 'vitest';
import { cifrar, cifrarPatch, descifrar, descifrarFila, estaCifrado } from './crypto';

const CLAVE = Buffer.alloc(32, 7).toString('base64');

beforeEach(() => {
  process.env.CREDENTIALS_KEY = CLAVE;
});

describe('cifrar / descifrar', () => {
  it('ida y vuelta', () => {
    const secreto = 'kapso_live_abc123';
    const cifrado = cifrar(secreto);
    expect(cifrado).not.toBe(secreto);
    expect(estaCifrado(cifrado)).toBe(true);
    expect(descifrar(cifrado)).toBe(secreto);
  });

  it('dos cifrados del mismo valor son distintos (IV aleatorio)', () => {
    expect(cifrar('mismo')).not.toBe(cifrar('mismo'));
  });

  it('no vuelve a cifrar lo ya cifrado', () => {
    const una = cifrar('x');
    expect(cifrar(una)).toBe(una);
  });

  it('el texto plano heredado pasa tal cual', () => {
    // Es lo que permite migrar sin un momento en que todo esté roto.
    expect(descifrar('llave-vieja-en-claro')).toBe('llave-vieja-en-claro');
  });

  it('null y vacío no se tocan', () => {
    expect(cifrar(null)).toBeNull();
    expect(cifrar('')).toBeNull();
    expect(descifrar(null)).toBeNull();
  });

  it('una clave equivocada no descifra: falla, no devuelve basura', () => {
    const cifrado = cifrar('secreto');
    process.env.CREDENTIALS_KEY = Buffer.alloc(32, 9).toString('base64');
    expect(() => descifrar(cifrado)).toThrow();
  });

  it('sin clave, un valor cifrado explota en vez de viajar como si fuera la llave', () => {
    const cifrado = cifrar('secreto');
    delete process.env.CREDENTIALS_KEY;
    expect(() => descifrar(cifrado)).toThrow(/CREDENTIALS_KEY/);
  });

  it('una clave de largo inválido se rechaza', () => {
    process.env.CREDENTIALS_KEY = Buffer.alloc(16, 1).toString('base64');
    expect(() => cifrar('x')).toThrow(/32 bytes/);
  });
});

describe('columnas de la fila', () => {
  it('cifra solo los secretos, no los identificadores', () => {
    const patch = cifrarPatch({
      whatsapp_provider: 'evolution',
      evolution_instance: 'bros-and-subs',
      evolution_api_key: 'super-secreta',
      wompi_public_key: 'pub_test_visible',
    });
    expect(patch.whatsapp_provider).toBe('evolution');
    expect(patch.evolution_instance).toBe('bros-and-subs');
    // La llave pública viaja al navegador del comensal: cifrarla no protege nada.
    expect(patch.wompi_public_key).toBe('pub_test_visible');
    expect(estaCifrado(patch.evolution_api_key as string)).toBe(true);
  });

  it('la fila vuelve en claro para el resto del backend', () => {
    const guardada = cifrarPatch({ kapso_api_key: 'k-123', wompi_events_secret: 'e-456' });
    const leida = descifrarFila(guardada);
    expect(leida.kapso_api_key).toBe('k-123');
    expect(leida.wompi_events_secret).toBe('e-456');
  });
});

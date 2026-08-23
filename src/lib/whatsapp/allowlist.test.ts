import { afterEach, describe, expect, it } from 'vitest';
import { filtroActivo, listaBlanca, numeroPermitido } from './allowlist';

const original = process.env.WHATSAPP_ALLOWLIST;

function conLista(valor: string | undefined) {
  if (valor === undefined) delete process.env.WHATSAPP_ALLOWLIST;
  else process.env.WHATSAPP_ALLOWLIST = valor;
}

afterEach(() => conLista(original));

describe('lista blanca de WhatsApp', () => {
  it('sin variable, deja pasar a todo el mundo', () => {
    conLista(undefined);
    expect(filtroActivo()).toBe(false);
    expect(numeroPermitido('573001112233')).toBe(true);
  });

  it('con la variable vacía, también deja pasar a todo el mundo', () => {
    // Es el caso peligroso: `WHATSAPP_ALLOWLIST=""` en un .env llega como
    // cadena vacía, y si eso se leyera como "lista de cero permitidos" el bot
    // se quedaría mudo para todos.
    conLista('');
    expect(filtroActivo()).toBe(false);
    expect(numeroPermitido('573001112233')).toBe(true);
  });

  it('reconoce el mismo número escrito de todas las formas en que llega', () => {
    conLista('3013589021');
    for (const forma of [
      '3013589021',
      '573013589021',
      '+573013589021',
      '+57 301 358 9021',
      'whatsapp:+573013589021',
    ]) {
      expect(numeroPermitido(forma), forma).toBe(true);
    }
  });

  it('bloquea a cualquier otro número', () => {
    conLista('3013589021');
    expect(numeroPermitido('573001112233')).toBe(false);
    expect(numeroPermitido('')).toBe(false);
    expect(numeroPermitido(undefined)).toBe(false);
  });

  it('no confunde números que solo comparten el final', () => {
    conLista('3013589021');
    // Mismo cierre, distinto número nacional.
    expect(numeroPermitido('3113589021')).toBe(false);
  });

  it('acepta varios números y descarta la basura', () => {
    conLista('3013589021, +57 300 111 2233 , 123, ');
    expect(listaBlanca()).toEqual(['3013589021', '3001112233']);
    expect(numeroPermitido('573001112233')).toBe(true);
  });
});

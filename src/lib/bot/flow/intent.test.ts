import { describe, it, expect } from 'vitest';
import { detectPedirIntent } from './intent';

describe('detectPedirIntent', () => {
  it('reconoce el texto exacto del botón de carrito vencido', () => {
    expect(detectPedirIntent('Quiero hacer un pedido')).toBe(true);
  });

  it('reconoce variantes comunes de querer pedir', () => {
    for (const t of [
      'pedir',
      'quiero pedir',
      'quiero pedir algo',
      'hacer un pedido',
      'me gustaría hacer un pedido',
      'ver carta',
      'la carta porfa',
      'menú',
      'ordenar',
    ]) {
      expect(detectPedirIntent(t), t).toBe(true);
    }
  });

  it('NO dispara con saludos / negativas / otros temas', () => {
    for (const t of ['hola', 'buenas', 'gracias', 'no quiero nada', 'dónde quedan', '']) {
      expect(detectPedirIntent(t), t).toBe(false);
    }
  });

  it('ignora texto vacío o undefined', () => {
    expect(detectPedirIntent(undefined)).toBe(false);
    expect(detectPedirIntent('   ')).toBe(false);
  });

  it('ignora mensajes demasiado largos (no son una orden corta)', () => {
    expect(detectPedirIntent('pedir '.repeat(20))).toBe(false);
  });
});

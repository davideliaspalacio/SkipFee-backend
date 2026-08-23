import { describe, expect, it } from 'vitest';
import {
  flattenSections,
  matchPendingOption,
  normalizeReply,
  renderCtaAsText,
  renderNumberedMenu,
} from './degrade';

const MENU = [
  { id: 'btn_pedir', title: 'Hacer pedido' },
  { id: 'btn_menu', title: 'Ver el menú' },
  { id: 'btn_humano', title: 'Hablar con alguien' },
];

describe('normalizeReply', () => {
  it('convierte emojis de dígito a número', () => {
    expect(normalizeReply('2️⃣')).toBe('2');
  });

  it('quita tildes, mayúsculas y puntuación de borde', () => {
    expect(normalizeReply('  ¡Sí, Guardar! ')).toBe('si, guardar');
    expect(normalizeReply('2.')).toBe('2');
    expect(normalizeReply('2)')).toBe('2');
  });
});

describe('renderNumberedMenu', () => {
  it('numera las opciones y devuelve el mapeo de vuelta', () => {
    const { text, pending } = renderNumberedMenu({
      body: '¿Qué quieres hacer?',
      options: MENU,
    });

    expect(text).toContain('¿Qué quieres hacer?');
    expect(text).toContain('1️⃣ Hacer pedido');
    expect(text).toContain('3️⃣ Hablar con alguien');
    expect(text).toContain('Responde con el número de la opción (1-3).');

    expect(pending.options).toEqual([
      { key: '1', id: 'btn_pedir', title: 'Hacer pedido' },
      { key: '2', id: 'btn_menu', title: 'Ver el menú' },
      { key: '3', id: 'btn_humano', title: 'Hablar con alguien' },
    ]);
  });

  it('incluye header y footer cuando vienen', () => {
    const { text } = renderNumberedMenu({
      body: 'cuerpo',
      options: [{ id: 'a', title: 'A' }],
      header: 'Título',
      footer: 'pie',
    });
    expect(text).toContain('*Título*');
    expect(text).toContain('_pie_');
  });

  it('usa prompt singular cuando hay una sola opción', () => {
    const { text } = renderNumberedMenu({
      body: 'cuerpo',
      options: [{ id: 'a', title: 'A' }],
    });
    expect(text).toContain('Responde *1* para continuar.');
  });
});

describe('matchPendingOption — la mitad de vuelta', () => {
  const { pending } = renderNumberedMenu({ body: 'x', options: MENU });

  it('casa por número', () => {
    expect(matchPendingOption('2', pending)).toBe('btn_menu');
  });

  it('casa por número con puntuación o emoji', () => {
    expect(matchPendingOption('1.', pending)).toBe('btn_pedir');
    expect(matchPendingOption('3️⃣', pending)).toBe('btn_humano');
  });

  it('casa por título exacto sin tildes ni mayúsculas', () => {
    expect(matchPendingOption('VER EL MENU', pending)).toBe('btn_menu');
  });

  it('casa por título como prefijo', () => {
    expect(matchPendingOption('hacer pedido por favor', pending)).toBe('btn_pedir');
  });

  it('devuelve null si no hay match claro', () => {
    expect(matchPendingOption('quiero una hamburguesa', pending)).toBeNull();
    expect(matchPendingOption('9', pending)).toBeNull();
    expect(matchPendingOption('', pending)).toBeNull();
  });

  it('devuelve null sin opciones pendientes', () => {
    expect(matchPendingOption('1', null)).toBeNull();
    expect(matchPendingOption('1', { options: [], sentAt: '' })).toBeNull();
  });

  it('no hace matching difuso: un título corto no matchea por prefijo', () => {
    const { pending: p } = renderNumberedMenu({
      body: 'x',
      options: [{ id: 'si', title: 'Sí' }],
    });
    // "si" tiene 2 chars (<4), así que "sirve así" NO debe matchear.
    expect(matchPendingOption('sirve asi', p)).toBeNull();
    // pero el título exacto sí
    expect(matchPendingOption('Sí', p)).toBe('si');
  });
});

describe('flattenSections', () => {
  it('aplana y prefija con el título de sección', () => {
    const flat = flattenSections([
      { title: 'Combos', rows: [{ id: 'c1', title: 'Sub de pollo' }] },
      { rows: [{ id: 'b1', title: 'Bebida', description: 'fría' }] },
    ]);
    expect(flat).toEqual([
      { id: 'c1', title: 'Combos · Sub de pollo', description: undefined },
      { id: 'b1', title: 'Bebida', description: 'fría' },
    ]);
  });
});

describe('renderCtaAsText', () => {
  it('mete el link en el cuerpo', () => {
    const t = renderCtaAsText({
      body: 'Tu pedido está listo para pagar',
      displayText: 'Abrir la tienda',
      url: 'https://tienda.skipfee.co/pedir?orderId=abc',
    });
    expect(t).toContain('Tu pedido está listo para pagar');
    expect(t).toContain('👉 Abrir la tienda:');
    expect(t).toContain('https://tienda.skipfee.co/pedir?orderId=abc');
  });
});

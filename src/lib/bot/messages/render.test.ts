import { describe, it, expect } from 'vitest';
import { render, extractVariables } from './render';

describe('render', () => {
  it('reemplaza una variable simple', () => {
    expect(render('Hola {{nombre}}', { nombre: 'Juan' })).toBe('Hola Juan');
  });

  it('reemplaza múltiples y repetidas', () => {
    expect(render('{{a}}-{{b}}-{{a}}', { a: 'x', b: 'y' })).toBe('x-y-x');
  });

  it('variable ausente → cadena vacía (no rompe)', () => {
    expect(render('Hola {{nombre}}!', {})).toBe('Hola !');
    expect(render('Hola {{nombre}}!', { nombre: undefined })).toBe('Hola !');
    expect(render('Hola {{nombre}}!', { nombre: null })).toBe('Hola !');
  });

  it('tolera espacios dentro de las llaves', () => {
    expect(render('Hola {{ nombre }}', { nombre: 'Ana' })).toBe('Hola Ana');
  });

  it('deja literal el $ antes de {{tarifa}} (precios)', () => {
    expect(render('domicilio ${{tarifa}}', { tarifa: '4.500' })).toBe('domicilio $4.500');
  });

  it('convierte números a string', () => {
    expect(render('{{n}} items', { n: 3 })).toBe('3 items');
  });

  it('sin placeholders devuelve el texto igual', () => {
    expect(render('¡Gracias!', { x: 'y' })).toBe('¡Gracias!');
  });

  it('no toca llaves malformadas', () => {
    expect(render('{nombre} {{}}', { nombre: 'x' })).toBe('{nombre} {{}}');
  });
});

describe('extractVariables', () => {
  it('devuelve los nombres únicos', () => {
    expect(extractVariables('{{a}} {{b}} {{a}}')).toEqual(['a', 'b']);
  });
  it('vacío si no hay variables', () => {
    expect(extractVariables('texto plano')).toEqual([]);
  });
});

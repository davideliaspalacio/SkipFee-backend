import { describe, it, expect } from 'vitest';
import {
  isWithinDayHours,
  isOpenNow,
  scanNextOpening,
  computeOpenState,
  type WeekHours,
} from './hours';

const allOpen = (open = '08:00', close = '20:00'): WeekHours =>
  Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(d => [d, { open, close }]));

describe('isWithinDayHours', () => {
  const d = { open: '08:00', close: '20:00' };
  it('dentro del rango', () => {
    expect(isWithinDayHours('08:00', d)).toBe(true);
    expect(isWithinDayHours('11:30', d)).toBe(true);
    expect(isWithinDayHours('19:59', d)).toBe(true);
  });
  it('fuera del rango', () => {
    expect(isWithinDayHours('07:59', d)).toBe(false);
    expect(isWithinDayHours('20:00', d)).toBe(false); // al cierre exacto ya está cerrado
    expect(isWithinDayHours('23:00', d)).toBe(false);
  });
  it('día cerrado o incompleto', () => {
    expect(isWithinDayHours('12:00', { closed: true, open: '08:00', close: '20:00' })).toBe(false);
    expect(isWithinDayHours('12:00', undefined)).toBe(false);
    expect(isWithinDayHours('12:00', { open: '08:00' })).toBe(false);
  });
  it('cruce de medianoche (18:00 → 02:00)', () => {
    const n = { open: '18:00', close: '02:00' };
    expect(isWithinDayHours('23:00', n)).toBe(true);
    expect(isWithinDayHours('01:30', n)).toBe(true);
    expect(isWithinDayHours('18:00', n)).toBe(true);
    expect(isWithinDayHours('02:00', n)).toBe(false);
    expect(isWithinDayHours('12:00', n)).toBe(false);
  });
  it('rango de longitud 0 → cerrado', () => {
    expect(isWithinDayHours('10:00', { open: '10:00', close: '10:00' })).toBe(false);
  });
});

describe('isOpenNow (integración con timezone)', () => {
  it('abierto 24h → siempre abierto', () => {
    expect(isOpenNow(allOpen('00:00', '23:59'), new Date('2026-06-03T16:00:00Z'))).toBe(true);
  });
  it('todos los días cerrados → cerrado', () => {
    const hours = Object.fromEntries(
      ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(d => [d, { closed: true }]),
    ) as WeekHours;
    expect(isOpenNow(hours, new Date('2026-06-03T16:00:00Z'))).toBe(false);
  });
});

describe('scanNextOpening', () => {
  it('hoy, antes de abrir', () => {
    expect(scanNextOpening(allOpen('11:00', '22:00'), 0, '09:00')).toBe('hoy a las 11:00 a. m.');
  });
  it('ya pasó la apertura de hoy → mañana', () => {
    expect(scanNextOpening(allOpen('11:00', '22:00'), 0, '23:30')).toBe('mañana a las 11:00 a. m.');
  });
  it('hoy cerrado → mañana', () => {
    const hours: WeekHours = { mon: { closed: true }, tue: { open: '10:00', close: '20:00' } };
    expect(scanNextOpening(hours, 0, '09:00')).toBe('mañana a las 10:00 a. m.');
  });
  it('solo sábado abierto → nombra el día', () => {
    const hours: WeekHours = { sat: { open: '14:00', close: '23:00' } };
    expect(scanNextOpening(hours, 0, '09:00')).toBe('el sábado a las 2:00 p. m.');
  });
  it('todo cerrado → null', () => {
    expect(scanNextOpening({}, 0, '09:00')).toBeNull();
  });
});

describe('computeOpenState', () => {
  it('pausa manual → cerrado y paused', () => {
    expect(computeOpenState({ orders_paused: true, hours: allOpen() }, new Date('2026-06-03T16:00:00Z')))
      .toEqual({ open: false, paused: true, opensLabel: null });
  });
  it('sin hours → fail-open', () => {
    expect(computeOpenState({}, new Date('2026-06-03T16:00:00Z')))
      .toEqual({ open: true, paused: false, opensLabel: null });
    expect(computeOpenState(null, new Date('2026-06-03T16:00:00Z')).open).toBe(true);
  });
  it('abierto ahora → open sin label', () => {
    const s = computeOpenState({ hours: allOpen('00:00', '23:59') }, new Date('2026-06-03T16:00:00Z'));
    expect(s.open).toBe(true);
    expect(s.opensLabel).toBeNull();
  });
  it('cerrado ahora → open=false con label de apertura', () => {
    const s = computeOpenState({ hours: allOpen('08:00', '09:00') }, new Date('2026-06-03T16:00:00Z')); // 11:00 Bogotá
    expect(s.open).toBe(false);
    expect(s.opensLabel).toContain('a. m.');
  });
});

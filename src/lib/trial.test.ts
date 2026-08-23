import { describe, expect, it, vi } from 'vitest';
import { diasRestantes, estadoDeSuscripcion, pruebaVencida } from './trial';

const DIA = 86_400_000;

describe('diasRestantes', () => {
  it('sin fecha no hay reloj', () => {
    expect(diasRestantes(null)).toBeNull();
  });

  it('redondea hacia arriba: quedan "3 días" hasta el último instante', () => {
    const ahora = new Date('2026-08-21T12:00:00Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(ahora);

    expect(diasRestantes(new Date(ahora + 3 * DIA).toISOString())).toBe(3);
    // Falta poco más de 2 días → sigue diciendo 3, no 2. Un negocio al que le
    // quedan 2 días y 1 hora no debería leer "quedan 2 días".
    expect(diasRestantes(new Date(ahora + 2 * DIA + 3_600_000).toISOString())).toBe(3);

    vi.restoreAllMocks();
  });

  it('devuelve negativo si ya venció', () => {
    const ahora = Date.now();
    expect(diasRestantes(new Date(ahora - 2 * DIA).toISOString())).toBeLessThan(0);
  });

  it('una fecha inválida no rompe: no hay reloj', () => {
    expect(diasRestantes('mañana')).toBeNull();
  });
});

describe('estadoDeSuscripcion', () => {
  it('sin plan asume trial y empresa activa', () => {
    const e = estadoDeSuscripcion({});
    expect(e.plan).toBe('trial');
    expect(e.status).toBe('active');
    expect(e.trialStartedAt).toBeNull();
    expect(e.diasRestantes).toBeNull();
  });

  it('cortesía no tiene vencimiento aunque haya fechas viejas', () => {
    const e = estadoDeSuscripcion({ plan: 'cortesia', status: 'active', trial_ends_at: null });
    expect(e.plan).toBe('cortesia');
    expect(e.diasRestantes).toBeNull();
  });

  it('traduce las columnas snake_case de la BD', () => {
    const fin = new Date(Date.now() + 5 * DIA).toISOString();
    const e = estadoDeSuscripcion({
      plan: 'trial',
      status: 'suspended',
      trial_started_at: '2026-08-01T00:00:00Z',
      trial_ends_at: fin,
    });
    expect(e.status).toBe('suspended');
    expect(e.trialStartedAt).toBe('2026-08-01T00:00:00Z');
    expect(e.trialEndsAt).toBe(fin);
    expect(e.diasRestantes).toBe(5);
  });
});

describe('pruebaVencida', () => {
  it('solo aplica a plan trial', () => {
    const ayer = new Date(Date.now() - DIA).toISOString();
    expect(pruebaVencida({ plan: 'trial', trial_ends_at: ayer })).toBe(true);
    // Pagando o en cortesía no se bloquea el panel aunque quede una fecha vieja.
    expect(pruebaVencida({ plan: 'activo', trial_ends_at: ayer })).toBe(false);
    expect(pruebaVencida({ plan: 'cortesia', trial_ends_at: ayer })).toBe(false);
  });

  it('sin reloj no está vencida', () => {
    expect(pruebaVencida({ plan: 'trial', trial_ends_at: null })).toBe(false);
    expect(pruebaVencida({})).toBe(false);
  });

  it('con la prueba corriendo no bloquea', () => {
    expect(pruebaVencida({ plan: 'trial', trial_ends_at: new Date(Date.now() + DIA).toISOString() })).toBe(false);
  });

  it('una fecha inválida no bloquea: ante la duda, el dueño entra', () => {
    expect(pruebaVencida({ plan: 'trial', trial_ends_at: 'ayer' })).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clientIp,
  isDisposableEmail,
  rateLimitSignup,
  resetSignupRateLimit,
  verifyTurnstile,
} from './signup-guard';

beforeEach(() => {
  resetSignupRateLimit();
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.SIGNUP_MAX_POR_HORA;
  vi.unstubAllGlobals();
});

describe('isDisposableEmail', () => {
  it('bloquea los desechables comunes', () => {
    expect(isDisposableEmail('a@mailinator.com')).toBe(true);
    expect(isDisposableEmail('A@YOPMAIL.COM')).toBe(true);
  });

  it('deja pasar los normales', () => {
    expect(isDisposableEmail('dueno@napoli.co')).toBe(false);
    expect(isDisposableEmail('a@gmail.com')).toBe(false);
  });
});

describe('rateLimitSignup', () => {
  // El límite se apaga solo fuera de producción (probar el registro exige crear
  // cuentas a repetición). Los tests lo fuerzan para poder verificarlo.
  beforeEach(() => {
    process.env.SIGNUP_MAX_POR_HORA = '3';
  });

  it('permite hasta 3 por IP y luego corta', () => {
    for (let i = 0; i < 3; i++) {
      expect(rateLimitSignup('1.2.3.4').allowed).toBe(true);
    }
    const cuarto = rateLimitSignup('1.2.3.4');
    expect(cuarto.allowed).toBe(false);
    expect(cuarto.retryAfterMinutes).toBeGreaterThan(0);
  });

  it('cuenta por IP, no globalmente', () => {
    for (let i = 0; i < 3; i++) rateLimitSignup('1.1.1.1');
    expect(rateLimitSignup('2.2.2.2').allowed).toBe(true);
  });

  it('en desarrollo no limita: el equipo no debe quedarse fuera de su propia máquina', () => {
    delete process.env.SIGNUP_MAX_POR_HORA; // NODE_ENV de los tests no es 'production'
    for (let i = 0; i < 20; i++) {
      expect(rateLimitSignup('9.9.9.9').allowed).toBe(true);
    }
  });

  it('SIGNUP_MAX_POR_HORA=0 desactiva el límite explícitamente', () => {
    process.env.SIGNUP_MAX_POR_HORA = '0';
    for (let i = 0; i < 10; i++) {
      expect(rateLimitSignup('8.8.8.8').allowed).toBe(true);
    }
  });
});

describe('verifyTurnstile', () => {
  it('sin secreto configurado deja pasar (dev)', async () => {
    expect(await verifyTurnstile(undefined)).toBe(true);
  });

  it('con secreto configurado exige token', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secreto';
    expect(await verifyTurnstile(undefined)).toBe(false);
  });

  it('acepta el token que Cloudflare valida', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secreto';
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: true })));
    expect(await verifyTurnstile('tok')).toBe(true);
  });

  it('rechaza el token que Cloudflare invalida', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secreto';
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: false })));
    expect(await verifyTurnstile('tok')).toBe(false);
  });

  it('si Cloudflare no responde NO bloquea el registro', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secreto';
    vi.stubGlobal('fetch', async () => { throw new Error('timeout'); });
    // Preferimos dejar pasar a alguien legítimo que caernos por una dependencia externa.
    expect(await verifyTurnstile('tok')).toBe(true);
  });
});

describe('clientIp', () => {
  it('respeta los headers de proxy en orden', () => {
    expect(clientIp(new Headers({ 'cf-connecting-ip': '9.9.9.9' }))).toBe('9.9.9.9');
    expect(clientIp(new Headers({ 'x-forwarded-for': '8.8.8.8, 1.1.1.1' }))).toBe('8.8.8.8');
    expect(clientIp(new Headers())).toBe('desconocida');
  });
});

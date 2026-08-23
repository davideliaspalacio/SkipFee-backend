/**
 * Defensas del registro público.
 *
 * Con alta asistida no hacían falta: creaba las cuentas el owner. Con registro
 * abierto, cada alta consume recursos reales —una instancia de WhatsApp come
 * 300–500 MB— así que un grifo abierto es costo variable sin ingreso.
 *
 * El orden es deliberado: primero lo invisible y gratis, y solo después lo que
 * añade fricción. Es el camino que recorrió Koyeb ida y vuelta tras exigirle
 * método de pago a todo el mundo y tener que dar marcha atrás.
 *
 * La defensa MÁS fuerte no está acá: es no aprovisionar nada caro (número de
 * WhatsApp dedicado) hasta que Meta valide el número, porque Meta ya exige
 * verificación por SMS, PIN y revisión del nombre comercial. Ese anti-abuso nos
 * sale gratis.
 */

/**
 * Dominios de correo desechable más comunes. No pretende ser exhaustivo —eso
 * sería una lista infinita— sino subir el costo del abuso casual.
 */
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'trashmail.com',
  'getnada.com', 'sharklasers.com', 'maildrop.cc', 'fakeinbox.com',
  'dispostable.com', 'mintemail.com', 'mohmal.com', 'tempr.email',
]);

export function isDisposableEmail(email: string): boolean {
  const domain = email.toLowerCase().split('@')[1];
  return !!domain && DISPOSABLE_DOMAINS.has(domain);
}

// =========================================================================
// Rate limit por IP
// =========================================================================

/**
 * Ventana deslizante en memoria.
 *
 * ⚠️ Limitación conocida: vive en el proceso. Se reinicia con cada deploy y no
 * se comparte entre instancias. Es suficiente para frenar el abuso casual desde
 * una IP, NO para un ataque distribuido — para eso está Turnstile. Cuando el
 * backend escale a varias instancias, esto debe pasar a Redis o a una tabla.
 */
const WINDOW_MS = 60 * 60_000; // 1 hora

/**
 * Cuántas altas se permiten por IP y hora.
 *
 * En desarrollo no se limita: probar el registro exige crear cuentas a
 * repetición, y a la tercera el propio equipo se queda fuera una hora de su
 * máquina. La defensa existe para el mundo real, no para el localhost de quien
 * la está construyendo.
 *
 * `SIGNUP_MAX_POR_HORA` permite ajustarlo sin tocar código (0 = sin límite).
 */
function maxPorVentana(): number {
  const configurado = Number(process.env.SIGNUP_MAX_POR_HORA);
  if (Number.isFinite(configurado) && configurado >= 0) return configurado;
  return process.env.NODE_ENV === 'production' ? 3 : 0;
}

const hits = new Map<string, number[]>();

export function rateLimitSignup(ip: string): { allowed: boolean; retryAfterMinutes?: number } {
  const MAX_PER_WINDOW = maxPorVentana();
  if (MAX_PER_WINDOW === 0) return { allowed: true };

  const now = Date.now();
  const previous = (hits.get(ip) ?? []).filter(t => now - t < WINDOW_MS);

  if (previous.length >= MAX_PER_WINDOW) {
    const oldest = Math.min(...previous);
    const retryAfterMinutes = Math.ceil((WINDOW_MS - (now - oldest)) / 60_000);
    hits.set(ip, previous);
    return { allowed: false, retryAfterMinutes };
  }

  previous.push(now);
  hits.set(ip, previous);

  // Poda perezosa para que el Map no crezca sin límite.
  if (hits.size > 5_000) {
    for (const [k, v] of hits) {
      if (v.every(t => now - t >= WINDOW_MS)) hits.delete(k);
    }
  }

  return { allowed: true };
}

/** Solo para tests: vacía la ventana. */
export function resetSignupRateLimit(): void {
  hits.clear();
}

// =========================================================================
// Cloudflare Turnstile
// =========================================================================

/**
 * Verifica el token de Turnstile. Gratis e ilimitado en el plan estándar de
 * Cloudflare, e invisible para el usuario en el caso normal.
 *
 * Si `TURNSTILE_SECRET_KEY` no está configurada, se deja pasar: el registro no
 * debe romperse en un entorno sin captcha (dev, o antes de configurarlo). En
 * producción hay que setearla — sin ella esta defensa no existe.
 */
export async function verifyTurnstile(token: string | undefined): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token }),
      signal: AbortSignal.timeout(8_000),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    // Si Cloudflare no responde, NO bloqueamos el registro: preferimos dejar
    // pasar a alguien legítimo que caernos por una dependencia externa.
    console.error('[signup] Turnstile no respondió, se deja pasar', err);
    return true;
  }
}

/** IP del cliente, respetando los headers de proxy habituales. */
export function clientIp(headers: Headers): string {
  return (
    headers.get('cf-connecting-ip') ??
    headers.get('x-real-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'desconocida'
  );
}

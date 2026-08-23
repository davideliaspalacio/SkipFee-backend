import { supabaseAdmin } from './db';

/**
 * Prueba gratis: el reloj de cada empresa y la configuración de plataforma.
 *
 * El bloqueo ya existía (`companies.status = 'suspended'` → 403 en el backend y
 * los crons filtran por activas). Esto es lo que faltaba: cuándo empieza a
 * correr el tiempo y cuándo se acaba.
 *
 * Dos reglas, decididas por el negocio:
 *
 *   - El reloj arranca **al registrarse** (`arrancarTrial`, llamado desde el
 *     aprovisionamiento). Es lo que se puede explicar en una frase: "tienes N
 *     días desde hoy".
 *
 *   - Al vencer se bloquea el **panel**, no la venta. El bot sigue atendiendo y
 *     la tienda sigue cobrando; lo que se cierra es la puerta del dueño. Es la
 *     inversión de Tiendanube: el dolor cae sobre quien firma el cheque, no
 *     sobre sus clientes. Ese corte lo aplica `getTenantContext` (`lib/tenant`),
 *     que es por donde pasan todas las rutas del panel y ninguna pública.
 */

export interface PlatformSettings {
  trialDays: number;
  alVencer: 'bloquear' | 'avisar';
}

export interface EstadoSuscripcion {
  plan: 'trial' | 'activo' | 'cortesia';
  status: string;
  /** null mientras el negocio no quede operativo. */
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  /** Días completos que faltan. null si no hay reloj corriendo. Negativo = vencida. */
  diasRestantes: number | null;
}

const DEFAULTS: PlatformSettings = { trialDays: 7, alVencer: 'bloquear' };
const CACHE_MS = 60_000;

let cache: { valor: PlatformSettings; hasta: number } | null = null;

/** Configuración de plataforma, cacheada 60 s (la leen crons y altas). */
export async function platformSettings(): Promise<PlatformSettings> {
  if (cache && cache.hasta > Date.now()) return cache.valor;

  const { data, error } = await supabaseAdmin()
    .from('platform_settings')
    .select('trial_days, al_vencer')
    .eq('id', 1)
    .maybeSingle();

  // Sin fila (o sin migración 0053) seguimos con los defaults: una config que
  // no se pudo leer no debería tumbar el alta de una empresa.
  if (error || !data) {
    if (error) console.warn('[trial] platform_settings no disponible:', error.message);
    return DEFAULTS;
  }

  const valor: PlatformSettings = {
    trialDays: (data.trial_days as number) ?? DEFAULTS.trialDays,
    alVencer: ((data.al_vencer as string) ?? DEFAULTS.alVencer) as PlatformSettings['alVencer'],
  };
  cache = { valor, hasta: Date.now() + CACHE_MS };
  return valor;
}

/** Invalida el caché tras un PATCH de plataforma. */
export function olvidarPlatformSettings(): void {
  cache = null;
}

export function diasRestantes(trialEndsAt: string | null): number | null {
  if (!trialEndsAt) return null;
  const fin = new Date(trialEndsAt).getTime();
  if (!Number.isFinite(fin)) return null;
  return Math.ceil((fin - Date.now()) / 86_400_000);
}

/**
 * Arranca el reloj de la prueba. Se llama al crear la empresa.
 *
 * Idempotente: solo escribe si `plan = 'trial'` y `trial_started_at` sigue en
 * null. Devuelve la fecha de vencimiento, o null si no había nada que hacer.
 */
export async function arrancarTrial(companyId: string): Promise<string | null> {
  const { trialDays } = await platformSettings();
  const ahora = new Date();
  const fin = new Date(ahora.getTime() + trialDays * 86_400_000);

  const { data, error } = await supabaseAdmin()
    .from('companies')
    .update({ trial_started_at: ahora.toISOString(), trial_ends_at: fin.toISOString() })
    .eq('id', companyId)
    .eq('plan', 'trial')
    .is('trial_started_at', null)
    .select('trial_ends_at')
    .maybeSingle();

  if (error) {
    console.warn('[trial] no se pudo arrancar el reloj:', error.message);
    return null;
  }
  return (data?.trial_ends_at as string | null) ?? null;
}

/** Estado de suscripción tal como lo consume el panel. */
export function estadoDeSuscripcion(row: {
  plan?: string | null;
  status?: string | null;
  trial_started_at?: string | null;
  trial_ends_at?: string | null;
}): EstadoSuscripcion {
  const trialEndsAt = row.trial_ends_at ?? null;
  return {
    plan: ((row.plan as EstadoSuscripcion['plan']) ?? 'trial'),
    status: row.status ?? 'active',
    trialStartedAt: row.trial_started_at ?? null,
    trialEndsAt,
    diasRestantes: diasRestantes(trialEndsAt),
  };
}

/**
 * ¿Está vencida la prueba de esta empresa?
 *
 * Solo aplica a `plan = 'trial'`: `activo` paga y `cortesia` no tiene reloj.
 * Lo usa el corte del panel en `lib/tenant`.
 */
export function pruebaVencida(row: {
  plan?: string | null;
  trial_ends_at?: string | null;
}): boolean {
  if ((row.plan ?? 'trial') !== 'trial') return false;
  if (!row.trial_ends_at) return false;
  const fin = new Date(row.trial_ends_at).getTime();
  return Number.isFinite(fin) && fin < Date.now();
}

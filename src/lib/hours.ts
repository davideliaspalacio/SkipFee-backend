import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaTime } from './pricing';

/**
 * Horario de operación POR DÍA + estado abierto/cerrado.
 *
 * Regla de oro: **fail-open**. Si la config de horario falta o algo falla, NO
 * se bloquea (el negocio prefiere recibir el pedido a perderlo por un glitch).
 * El bloqueo real solo ocurre cuando hay `hours` configurado y la hora cae
 * fuera, o cuando `orders_paused` está activo.
 */

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const DAY_ORDER: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const DAY_ES: Record<DayKey, string> = {
  mon: 'lunes', tue: 'martes', wed: 'miércoles', thu: 'jueves',
  fri: 'viernes', sat: 'sábado', sun: 'domingo',
};

export interface DayHours {
  closed?: boolean;
  open?: string;  // "HH:MM"
  close?: string; // "HH:MM"
}
export type WeekHours = Partial<Record<DayKey, DayHours>>;

/**
 * ¿La hora "HH:MM" cae dentro del rango del día? Pura (sin tiempo real).
 * Soporta cruce de medianoche (ej. open 18:00, close 02:00).
 */
export function isWithinDayHours(t: string, d: DayHours | undefined): boolean {
  if (!d || d.closed || !d.open || !d.close) return false;
  const { open, close } = d;
  if (open === close) return false;              // rango de longitud 0 → cerrado
  if (close > open) return t >= open && t < close;
  return t >= open || t < close;                 // cruza medianoche
}

/** Día (mon..sun) y hora "HH:MM" en America/Bogota. */
export function bogotaParts(now: Date): { dayKey: DayKey; time: string } {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', weekday: 'short' })
    .format(now)
    .toLowerCase();
  const dayKey = (DAY_ORDER as string[]).includes(wd) ? (wd as DayKey) : 'mon';
  return { dayKey, time: bogotaTime(now) };
}

export function isOpenNow(hours: WeekHours, now: Date): boolean {
  const { dayKey, time } = bogotaParts(now);
  return isWithinDayHours(time, hours[dayKey]);
}

function to12h(hhmm: string): string {
  const [hStr, m] = hhmm.split(':');
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'p. m.' : 'a. m.';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

/**
 * Escanea la próxima apertura desde hoy hacia adelante (7 días). Pura.
 * `todayIdx` = índice de hoy en DAY_ORDER; `nowTime` = "HH:MM" actual.
 */
export function scanNextOpening(hours: WeekHours, todayIdx: number, nowTime: string): string | null {
  for (let offset = 0; offset < 7; offset++) {
    const key = DAY_ORDER[(todayIdx + offset) % 7];
    const d = hours[key];
    if (!d || d.closed || !d.open) continue;
    if (offset === 0 && !(nowTime < d.open)) continue; // hoy la apertura ya pasó
    const hora = to12h(d.open);
    if (offset === 0) return `hoy a las ${hora}`;
    if (offset === 1) return `mañana a las ${hora}`;
    return `el ${DAY_ES[key]} a las ${hora}`;
  }
  return null;
}

export function nextOpeningLabel(hours: WeekHours, now: Date): string | null {
  const { dayKey, time } = bogotaParts(now);
  return scanNextOpening(hours, DAY_ORDER.indexOf(dayKey), time);
}

export interface OpenState {
  open: boolean;
  paused: boolean;
  opensLabel: string | null;
}

interface SettingsLike {
  hours?: unknown;
  orders_paused?: unknown;
}

/** Calcula el estado a partir de una fila de settings (cualquier forma). Fail-open. */
export function computeOpenState(row: SettingsLike | null | undefined, now: Date): OpenState {
  if (row?.orders_paused === true) return { open: false, paused: true, opensLabel: null };
  const hours = row?.hours;
  if (!hours || typeof hours !== 'object') return { open: true, paused: false, opensLabel: null };
  const week = hours as WeekHours;
  const open = isOpenNow(week, now);
  return { open, paused: false, opensLabel: open ? null : nextOpeningLabel(week, now) };
}

/** Lee settings y calcula el estado abierto/cerrado. Fail-open ante cualquier error. */
export async function loadOpenState(sb: SupabaseClient, now: Date = new Date()): Promise<OpenState> {
  try {
    const { data, error } = await sb
      .from('settings')
      .select('hours, orders_paused')
      .eq('id', 1)
      .single();
    if (error || !data) return { open: true, paused: false, opensLabel: null };
    return computeOpenState(data as SettingsLike, now);
  } catch {
    return { open: true, paused: false, opensLabel: null };
  }
}

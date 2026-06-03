/**
 * Devuelve "HH:MM" en zona horaria America/Bogota.
 * Lo usan `lib/hours` (horario de operación) y las ventanas horarias de promos.
 */
export function bogotaTime(date = new Date()): string {
  return date.toLocaleTimeString('en-GB', {
    timeZone: 'America/Bogota',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Devuelve true si "now" (HH:MM) está dentro del rango [start, end].
 * Rangos simples (no cruzan medianoche). Lo usan las ventanas horarias de promos.
 */
export function isWithinRange(now: string, start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  return now >= start && now <= end;
}

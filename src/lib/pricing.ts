/**
 * Devuelve "HH:MM" en zona horaria America/Bogota.
 * Útil para comparar contra settings.peak_start / peak_end.
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
 * Soporta rangos sencillos (no cruzan medianoche, que es el caso de hora pico de almuerzo/cena).
 */
export function isWithinRange(now: string, start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  return now >= start && now <= end;
}

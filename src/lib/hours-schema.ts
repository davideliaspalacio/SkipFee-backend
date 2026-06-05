import { z } from 'zod';

/**
 * Validación Zod del horario semanal `hours` (jsonb). Compartido por el horario
 * del negocio (settings) y el de cada cocinero (cooks), para que ambos validen
 * exactamente igual. El shape coincide con `WeekHours`/`DayHours` de @/lib/hours.
 */

/** "HH:MM" en formato 24h. */
export const HHMM = /^\d{2}:\d{2}$/;

export const dayHoursSchema = z.object({
  closed: z.boolean().optional(),
  open: z.string().regex(HHMM).optional(),
  close: z.string().regex(HHMM).optional(),
});

export const hoursSchema = z.record(
  z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  dayHoursSchema,
);

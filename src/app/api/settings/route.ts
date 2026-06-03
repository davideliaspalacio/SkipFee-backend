import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/settings — devuelve la fila id=1 de settings (singleton).
 * PATCH /api/settings — edita campos editables. Solo se aceptan los campos
 * listados en el schema para no exponer cambios accidentales del id.
 */
export async function GET() {
  const { data, error } = await supabaseAdmin()
    .from('settings')
    .select('*')
    .eq('id', 1)
    .single();

  if (error) {
    console.error('[settings GET] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Serialización snake → camel para los campos editables
  return Response.json({
    ok: true,
    settings: {
      openHour: data.open_hour,
      closeHour: data.close_hour,
      openDays: data.open_days,
      peakStart: data.peak_start,
      peakEnd: data.peak_end,
      peakSurcharge: data.peak_surcharge,
      baseDeliveryFee: data.base_delivery_fee,
      reminderMinutes: data.reminder_minutes,
      hours: data.hours ?? null,
      ordersPaused: data.orders_paused ?? false,
      updatedAt: data.updated_at,
    },
  });
}

const HHMM = /^\d{2}:\d{2}$/;
const dayHoursSchema = z.object({
  closed: z.boolean().optional(),
  open: z.string().regex(HHMM).optional(),
  close: z.string().regex(HHMM).optional(),
});
const hoursSchema = z.record(
  z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  dayHoursSchema,
);

const patchSchema = z.object({
  openHour: z.string().regex(HHMM).optional(),
  closeHour: z.string().regex(HHMM).optional(),
  openDays: z.array(z.string()).optional(),
  peakStart: z.string().regex(HHMM).nullable().optional(),
  peakEnd: z.string().regex(HHMM).nullable().optional(),
  peakSurcharge: z.number().int().nonnegative().optional(),
  baseDeliveryFee: z.number().int().nonnegative().optional(),
  reminderMinutes: z.number().int().positive().optional(),
  hours: hoursSchema.optional(),
  ordersPaused: z.boolean().optional(),
});

export async function PATCH(request: NextRequest) {
  let body;
  try {
    body = patchSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  // Mapeo camel → snake para la BD
  const update: Record<string, unknown> = {};
  if (body.openHour !== undefined) update.open_hour = body.openHour;
  if (body.closeHour !== undefined) update.close_hour = body.closeHour;
  if (body.openDays !== undefined) update.open_days = body.openDays;
  if (body.peakStart !== undefined) update.peak_start = body.peakStart;
  if (body.peakEnd !== undefined) update.peak_end = body.peakEnd;
  if (body.peakSurcharge !== undefined) update.peak_surcharge = body.peakSurcharge;
  if (body.baseDeliveryFee !== undefined) update.base_delivery_fee = body.baseDeliveryFee;
  if (body.reminderMinutes !== undefined) update.reminder_minutes = body.reminderMinutes;
  if (body.hours !== undefined) update.hours = body.hours;
  if (body.ordersPaused !== undefined) update.orders_paused = body.ordersPaused;

  if (Object.keys(update).length === 0) {
    return Response.json({ ok: false, error: 'Nada que actualizar' }, { status: 400 });
  }

  update.updated_at = new Date().toISOString();

  const { error } = await supabaseAdmin().from('settings').update(update).eq('id', 1);
  if (error) {
    console.error('[settings PATCH] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}

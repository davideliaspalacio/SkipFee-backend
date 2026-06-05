import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { HHMM, hoursSchema } from '@/lib/hours-schema';

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
      deliveredWindowHours: data.delivered_window_hours ?? 8,
      // Post-venta (Tarea 3)
      surveyEnabled: data.survey_enabled ?? true,
      surveyDelayHours: data.survey_delay_hours ?? 1,
      reviewGiftEnabled: data.review_gift_enabled ?? true,
      reviewGiftName: data.review_gift_name ?? 'Postre',
      reviewGiftExpiryDays: data.review_gift_expiry_days ?? 30,
      reviewLink: data.review_link ?? 'https://maps.app.goo.gl/S3tbdt5KaTnBeioVA',
      surveyMinDays: data.survey_min_days ?? 30,
      updatedAt: data.updated_at,
    },
  });
}

// HHMM y hoursSchema viven en @/lib/hours-schema (compartidos con cooks).
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
  deliveredWindowHours: z.number().int().min(1).max(72).optional(),
  // Post-venta (Tarea 3)
  surveyEnabled: z.boolean().optional(),
  surveyDelayHours: z.number().int().min(0).max(72).optional(),
  reviewGiftEnabled: z.boolean().optional(),
  reviewGiftName: z.string().min(1).max(60).optional(),
  reviewGiftExpiryDays: z.number().int().min(1).max(365).optional(),
  reviewLink: z.string().url().max(500).optional(),
  surveyMinDays: z.number().int().min(0).max(365).optional(),
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
  if (body.deliveredWindowHours !== undefined) update.delivered_window_hours = body.deliveredWindowHours;
  if (body.surveyEnabled !== undefined) update.survey_enabled = body.surveyEnabled;
  if (body.surveyDelayHours !== undefined) update.survey_delay_hours = body.surveyDelayHours;
  if (body.reviewGiftEnabled !== undefined) update.review_gift_enabled = body.reviewGiftEnabled;
  if (body.reviewGiftName !== undefined) update.review_gift_name = body.reviewGiftName;
  if (body.reviewGiftExpiryDays !== undefined) update.review_gift_expiry_days = body.reviewGiftExpiryDays;
  if (body.reviewLink !== undefined) update.review_link = body.reviewLink;
  if (body.surveyMinDays !== undefined) update.survey_min_days = body.surveyMinDays;

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

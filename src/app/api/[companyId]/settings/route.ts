import { z } from 'zod';
import { HHMM, hoursSchema } from '@/lib/hours-schema';
import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/<companyId>/settings — devuelve la fila de settings de LA empresa.
 * PATCH /api/<companyId>/settings — edita campos editables. Solo se aceptan los
 * campos listados en el schema para no exponer cambios accidentales.
 *
 * Multi-empresa: hay una fila de settings por empresa, scopeada por
 * `company_id` (ya no existe el singleton `id=1`).
 */
export const GET = withTenant(async (_request, ctx) => {
  const { data, error } = await ctx.db
    .from('settings')
    .select('*')
    .eq('company_id', ctx.company.id)
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
      surveyDelayMinutes: data.survey_delay_minutes ?? 30,
      reviewGiftEnabled: data.review_gift_enabled ?? true,
      reviewGiftName: data.review_gift_name ?? null,
      reviewGiftExpiryDays: data.review_gift_expiry_days ?? 30,
      // Sin fallback: era el Google Maps del negocio piloto.
      reviewLink: data.review_link ?? null,
      surveyMinDays: data.survey_min_days ?? 30,
      reviewGiftProductId: data.review_gift_product_id ?? null,
      // Origen de los domicilios (panel Despachos). Tiene defaults para que el
      // panel funcione aunque el dueño no haya configurado la dirección.
      localAddress: data.local_address ?? null,
      // En qué se especializa el negocio. Lo usa el prompt del bot para
      // presentarse; sin esto se presenta como un restaurante genérico.
      businessDescription: data.business_description ?? null,
      // Marca del negocio: la tienda se pinta con esto.
      logoUrl: data.logo_url ?? null,
      brandColor: data.brand_color ?? null,
      localLat: data.local_lat,
      localLng: data.local_lng,
      localLabel: data.local_label,
      // Categorías de productos (administradas desde Configuración → Categorías).
      categories: data.categories ?? [],
      updatedAt: data.updated_at,
    },
  });
});

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
  surveyDelayMinutes: z.number().int().min(1).max(1440).optional(),
  reviewGiftEnabled: z.boolean().optional(),
  reviewGiftName: z.string().min(1).max(60).optional(),
  reviewGiftExpiryDays: z.number().int().min(1).max(365).optional(),
  reviewLink: z.string().url().max(500).optional(),
  surveyMinDays: z.number().int().min(0).max(365).optional(),
  // Producto de la categoría "Regalo" que se entrega gratis. null = desvincular.
  reviewGiftProductId: z.string().min(1).max(60).nullable().optional(),
  // Dirección del local (origen de los domicilios).
  localAddress: z.string().max(200).nullable().optional(),
  businessDescription: z.string().max(300).nullable().optional(),
  logoUrl: z.string().url().max(500).nullable().optional(),
  // Se inyecta en el CSS de la tienda: solo hex de 6 dígitos, nada libre.
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Usa un color en formato #RRGGBB')
    .nullable()
    .optional(),
  localLat: z.number().min(-90).max(90).optional(),
  localLng: z.number().min(-180).max(180).optional(),
  localLabel: z.string().min(1).max(40).optional(),
  // Categorías de productos. Lista completa (no patch parcial) — el frontend
  // envía la lista entera al guardar para que reordenar/eliminar sea atómico.
  categories: z.array(z.string().min(1).max(60)).max(50).optional(),
});

export const PATCH = withTenant(async (request, ctx) => {
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
  if (body.surveyDelayMinutes !== undefined) update.survey_delay_minutes = body.surveyDelayMinutes;
  if (body.reviewGiftEnabled !== undefined) update.review_gift_enabled = body.reviewGiftEnabled;
  if (body.reviewGiftName !== undefined) update.review_gift_name = body.reviewGiftName;
  if (body.reviewGiftExpiryDays !== undefined) update.review_gift_expiry_days = body.reviewGiftExpiryDays;
  if (body.reviewLink !== undefined) update.review_link = body.reviewLink;
  if (body.surveyMinDays !== undefined) update.survey_min_days = body.surveyMinDays;
  if (body.reviewGiftProductId !== undefined) update.review_gift_product_id = body.reviewGiftProductId;
  if (body.localAddress !== undefined) update.local_address = body.localAddress;
  if (body.businessDescription !== undefined) update.business_description = body.businessDescription;
  if (body.logoUrl !== undefined) update.logo_url = body.logoUrl;
  if (body.brandColor !== undefined) update.brand_color = body.brandColor;
  if (body.localLat !== undefined) update.local_lat = body.localLat;
  if (body.localLng !== undefined) update.local_lng = body.localLng;
  if (body.localLabel !== undefined) update.local_label = body.localLabel;
  if (body.categories !== undefined) {
    // Dedup conservando orden — protege contra ediciones que dejen duplicados
    // por error desde el UI.
    update.categories = Array.from(new Set(body.categories.map(c => c.trim()).filter(Boolean)));
  }

  if (Object.keys(update).length === 0) {
    return Response.json({ ok: false, error: 'Nada que actualizar' }, { status: 400 });
  }

  update.updated_at = new Date().toISOString();

  const { error } = await ctx.db
    .from('settings')
    .update(update)
    .eq('company_id', ctx.company.id);
  if (error) {
    console.error('[settings PATCH] error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
});

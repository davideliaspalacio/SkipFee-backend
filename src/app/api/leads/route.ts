import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Endpoint público que consume la landing (/pre-registro). El navegador postea
// acá (CORS lo maneja el middleware si el origen está en EXTRA_CORS_ORIGINS);
// guardamos en Supabase con service_role y avisamos a Discord. Los secretos
// (service_role, webhook) viven solo acá, nunca en el frontend.

const str = z.string().trim().max(2000).optional();

const bodySchema = z.object({
  whatsapp: str,
  business_name: str,
  contact_name: str,
  phone: str,
  email: str,
  contact_channel: str,
  plan: str,
  orders_volume: str,
  peak_hours: str,
  est_loss: str,
  city: str,
  current_apps: str,
  cuisine_type: str,
  estado: str,
  source: str,
  user_agent: str,
});

type Lead = z.infer<typeof bodySchema>;

function field(name: string, value: string | undefined, inline = true) {
  return { name, value: value && value.trim() ? value : '—', inline };
}

async function notifyDiscord(lead: Lead): Promise<void> {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  const calificado = lead.estado === 'calificado';
  const embed = {
    title: calificado ? '🎯 Nuevo lead calificado' : '📝 Nuevo pre-registro',
    color: calificado ? 0x16a34a : 0x64748b, // verde / gris
    fields: [
      field('Negocio', lead.business_name),
      field('Contacto', lead.contact_name),
      field('WhatsApp', lead.whatsapp ?? lead.phone),
      field('Email', lead.email),
      field('Ciudad', lead.city),
      field('Plan', lead.plan),
      field('Volumen', lead.orders_volume),
      field('Horas pico', lead.peak_hours),
      field('Pérdida estimada', lead.est_loss),
      field('Apps actuales', lead.current_apps),
      field('Tipo de cocina', lead.cuisine_type),
      field('Estado', lead.estado),
    ],
    footer: { text: lead.source ?? 'landing-preregistro' },
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Skipfee Leads', embeds: [embed] }),
    });
    if (!res.ok) {
      console.error('[leads] discord webhook', res.status, await res.text().catch(() => ''));
    }
  } catch (err) {
    console.error('[leads] discord webhook error', err);
  }
}

export async function POST(request: NextRequest) {
  let lead: Lead;
  try {
    lead = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  // Necesitamos al menos un dato de contacto.
  if (!lead.whatsapp && !lead.phone && !lead.email) {
    return Response.json({ ok: false, error: 'missing-contact' }, { status: 400 });
  }

  const { error } = await supabaseAdmin()
    .from('leads')
    .insert({ ...lead, source: lead.source ?? 'landing-preregistro' });

  if (error) {
    console.error('[leads] insert error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Discord es best-effort: si falla, el lead ya quedó guardado en Supabase.
  await notifyDiscord(lead);

  return Response.json({ ok: true });
}

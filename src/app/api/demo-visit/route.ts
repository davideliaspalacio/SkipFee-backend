import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Aviso a Discord cada vez que alguien entra a la DEMO pública del panel
// (admin /preview con ?demo=1). NO guarda nada en Supabase: solo notifica.
// Público; el origen del panel debe estar en EXTRA_CORS_ORIGINS para el CORS.

const str = z.string().trim().max(200).optional();
const bodySchema = z.object({
  negocio: str,
  plan: str,
  path: str,
  user_agent: z.string().trim().max(500).optional(),
});
type Body = z.infer<typeof bodySchema>;

// Throttle best-effort en memoria: 1 aviso por IP cada 10 min. En serverless
// multi-instancia no es perfecto, pero corta el spam evidente sin tocar la BD.
const RECENT = new Map<string, number>();
const WINDOW_MS = 10 * 60_000;
function throttled(ip: string): boolean {
  const now = Date.now();
  if (RECENT.size > 500) {
    for (const [k, t] of RECENT) if (now - t > WINDOW_MS) RECENT.delete(k);
  }
  const last = RECENT.get(ip);
  if (last && now - last < WINDOW_MS) return true;
  RECENT.set(ip, now);
  return false;
}

function clientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'desconocida';
}

async function notifyDiscord(body: Body, ip: string): Promise<void> {
  const url = env.DISCORD_DEMO_WEBHOOK_URL ?? env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  const embed = {
    title: '👀 Alguien está viendo la demo',
    color: 0x5e6ad2,
    fields: [
      { name: 'Negocio', value: body.negocio?.trim() || '—', inline: true },
      { name: 'Plan', value: body.plan?.trim() || '—', inline: true },
      { name: 'IP', value: ip, inline: true },
      { name: 'Pantalla', value: body.path?.trim() || '—', inline: false },
      { name: 'Navegador', value: (body.user_agent ?? '').slice(0, 180) || '—', inline: false },
    ],
    footer: { text: 'demo-visit' },
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Skipfee Demo', embeds: [embed] }),
    });
    if (!res.ok) console.error('[demo-visit] discord', res.status, await res.text().catch(() => ''));
  } catch (err) {
    console.error('[demo-visit] discord error', err);
  }
}

export async function POST(request: NextRequest) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  const body: Body = parsed.success ? parsed.data : {};
  const ip = clientIp(request);
  // Si está throttleado, respondemos ok sin volver a avisar.
  if (!throttled(ip)) {
    await notifyDiscord(body, ip);
  }
  return Response.json({ ok: true });
}

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { sendText } from '@/lib/kapso/client';
import { recordMessage } from '@/lib/messaging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// E.164 sin "+", solo dígitos. Ej: "573126451209" para +57 312 645 1209.
const bodySchema = z.object({
  to: z.string().regex(/^\d{8,15}$/, 'to debe ser un número E.164 sin "+", ej: 573126451209'),
  body: z.string().min(1).max(4096),
});

export async function POST(request: NextRequest) {
  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  // 1. Enviar vía Kapso
  let result;
  try {
    result = await sendText(parsed.to, parsed.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[messages/send] Kapso error', err);
    return Response.json({ ok: false, error: message }, { status: 502 });
  }

  // 2. Persistir el mensaje saliente. Si falla, no rechazamos el envío
  // (Kapso ya lo mandó), pero lo logueamos para auditar.
  const wamid = result.messages?.[0]?.id ?? null;
  try {
    await recordMessage({
      phone: parsed.to,
      direction: 'out',
      body: parsed.body,
      kapsoMessageId: wamid,
    });
  } catch (err) {
    console.error('[messages/send] persistence error (mensaje sí se envió)', err);
  }

  return Response.json({ ok: true, result });
}

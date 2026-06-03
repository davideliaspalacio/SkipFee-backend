import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/chats/:id/upload-image
 *
 * Sube una imagen al bucket `chat-media` para luego enviarla por WhatsApp.
 * Devuelve la URL pública que el frontend pasa a POST /messages.
 *
 * Naming: `<chat_id>/<timestamp>.<ext>`.
 *
 * Validaciones:
 *   - MIME image/(png|jpe?g|webp|gif)
 *   - tamaño ≤ 5 MB (límite seguro para WhatsApp Cloud, que tope ~5MB en
 *     imágenes — el caller puede subir más, pero Kapso lo rechazaría).
 *   - chat debe existir.
 */

const STORAGE_BUCKET = 'chat-media';
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = /^image\/(png|jpe?g|webp|gif)$/;

function extOfMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'bin';
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const sb = supabaseAdmin();

  const { data: chat } = await sb
    .from('chats')
    .select('id')
    .eq('id', id)
    .maybeSingle();
  if (!chat) {
    return Response.json({ ok: false, error: 'Chat no encontrado' }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, error: 'Body inválido (esperaba multipart)' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: 'Falta el campo `file`' }, { status: 400 });
  }
  if (!ALLOWED_MIME.test(file.type)) {
    return Response.json(
      { ok: false, error: 'Formato no permitido. Usa PNG, JPG, WEBP o GIF.' },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return Response.json(
      { ok: false, error: 'La imagen pesa más de 5 MB.' },
      { status: 400 },
    );
  }

  // El chat id viene con prefijo `wa:` (`wa:573136913188`). Lo limpio
  // para que el path en el bucket no tenga los dos puntos (los acepta, pero
  // la URL queda más fea y algunos clientes los re-escapan).
  const safeChatId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const ext = extOfMime(file.type);
  const path = `${safeChatId}/${Date.now()}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());

  const { error: upErr } = await sb.storage
    .from(STORAGE_BUCKET)
    .upload(path, buf, { contentType: file.type, upsert: false });
  if (upErr) {
    console.error('[chat upload-image] upload error', upErr);
    return Response.json({ ok: false, error: upErr.message }, { status: 500 });
  }

  const { data: pub } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return Response.json({ ok: true, url: pub.publicUrl });
}

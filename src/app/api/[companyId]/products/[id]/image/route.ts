import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/<companyId>/products/:id/image
 *
 * Recibe multipart/form-data con un campo `file` y sube la imagen al bucket
 * `product-images` de Supabase Storage. La URL pública resultante se guarda
 * en `products.img` y se devuelve al cliente para que actualice la UI.
 *
 * Naming (multi-empresa): `<company_id>/<product_id>/<timestamp>.<ext>` — el
 * prefijo de empresa aísla el storage entre empresas (cada una vive bajo su
 * propio "directorio"). Mantiene histórico cuando el cliente reemplaza la
 * imagen (storage es barato, se limpia con cron a futuro si crece mucho).
 *
 * Validaciones:
 *   - MIME debe empezar con `image/`
 *   - tamaño ≤ 5 MB
 *   - producto debe existir EN LA EMPRESA (devuelve 404 si no)
 */

const STORAGE_BUCKET = 'product-images';
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = /^image\/(png|jpe?g|webp|gif)$/;

function extOfMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'bin';
}

export const POST = withTenant<{ companyId: string; id: string }>(async (request, ctx, params) => {
  const { id } = params;
  const sb = ctx.db;
  const companyId = ctx.company.id;

  // 1. Verificar que el producto existe EN LA EMPRESA (no perder el upload
  //    contra un id inválido o de otra empresa).
  const { data: existing } = await sb
    .from('products')
    .select('id')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle();
  if (!existing) {
    return Response.json({ ok: false, error: 'Producto no encontrado' }, { status: 404 });
  }

  // 2. Parsear multipart.
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

  // 3. Subir al bucket. `<company_id>/<id>/<timestamp>.<ext>` (aislamiento por empresa).
  const ext = extOfMime(file.type);
  const path = `${companyId}/${id}/${Date.now()}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());

  const { error: upErr } = await sb.storage
    .from(STORAGE_BUCKET)
    .upload(path, buf, { contentType: file.type, upsert: false });
  if (upErr) {
    console.error('[products image] upload error', upErr);
    return Response.json({ ok: false, error: upErr.message }, { status: 500 });
  }

  // 4. URL pública (bucket público, sin signed URL).
  const { data: pub } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  const publicUrl = pub.publicUrl;

  // 5. Persistir en products.img (scopeado a la empresa).
  const { data: updated, error: updErr } = await sb
    .from('products')
    .update({ img: publicUrl })
    .eq('company_id', companyId)
    .eq('id', id)
    .select('id, name, price, cat, sold, available, img, description')
    .single();

  if (updErr || !updated) {
    console.error('[products image] update error', updErr);
    return Response.json({ ok: false, error: updErr?.message ?? 'update error' }, { status: 500 });
  }

  return Response.json({ ok: true, product: updated, url: publicUrl });
});

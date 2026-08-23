import { withTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/<companyId>/settings/logo
 *
 * Sube el logo del negocio y lo guarda en `settings.logo_url`. Mismo patrón que
 * la imagen de producto: bucket público `product-images`, ruta prefijada por
 * empresa (`<company_id>/marca/<timestamp>.<ext>`) para aislar el storage.
 *
 * El logo va a la cabecera de la tienda, o sea a la pantalla donde el comensal
 * pone su tarjeta. Ahí ver la marca del restaurante —y no la nuestra— es la
 * diferencia entre "le compro a este negocio" y "quién es esta gente".
 */

const STORAGE_BUCKET = 'product-images';
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = /^image\/(png|jpe?g|webp|svg\+xml)$/;

function extOfMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/svg+xml') return 'svg';
  return 'bin';
}

export const POST = withTenant(async (request, ctx) => {
  if (!['super_admin', 'admin', 'platform'].includes(ctx.role)) {
    return Response.json({ ok: false, error: 'Sin permiso' }, { status: 403 });
  }

  const companyId = ctx.company.id;
  const sb = ctx.db;

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
      { ok: false, error: 'Formato no permitido. Usa PNG, JPG, WEBP o SVG.' },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ ok: false, error: 'El logo pesa más de 2 MB.' }, { status: 400 });
  }

  const path = `${companyId}/marca/${Date.now()}.${extOfMime(file.type)}`;
  const buf = Buffer.from(await file.arrayBuffer());

  const { error: upErr } = await sb.storage
    .from(STORAGE_BUCKET)
    .upload(path, buf, { contentType: file.type, upsert: false });
  if (upErr) {
    console.error('[settings logo] upload error', upErr);
    return Response.json({ ok: false, error: upErr.message }, { status: 500 });
  }

  const { data: pub } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  const publicUrl = pub.publicUrl;

  const { error: updErr } = await sb
    .from('settings')
    .update({ logo_url: publicUrl })
    .eq('company_id', companyId);

  if (updErr) {
    console.error('[settings logo] update error', updErr);
    return Response.json({ ok: false, error: updErr.message }, { status: 500 });
  }

  return Response.json({ ok: true, url: publicUrl });
});

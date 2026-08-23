import { withTenant } from '@/lib/tenant';
import {
  MAX_BYTES,
  TIPOS_ACEPTADOS,
  extraerCarta,
} from '@/lib/catalog/extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/<code>/catalog/extract — foto o PDF de la carta → borrador editable.
 *
 * NO guarda nada. Devuelve lo que leyó para que el dueño lo revise y confirme
 * en `/catalog/import`. Ninguna plataforma del mercado publica un menú extraído
 * sin aprobación humana, y con razón: la precisión de precios ronda el 97%.
 *
 * La venta no es "cero trabajo", es "revisar en vez de tipear".
 */
export const POST = withTenant(async (request, ctx) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { ok: false, error: 'Manda la carta como archivo (multipart/form-data).' },
      { status: 400 },
    );
  }

  const archivo = form.get('file');
  if (!(archivo instanceof File)) {
    return Response.json({ ok: false, error: 'Falta el archivo de la carta.' }, { status: 400 });
  }

  if (!TIPOS_ACEPTADOS.includes(archivo.type)) {
    return Response.json(
      { ok: false, error: 'Manda una foto (JPG, PNG o WEBP) o un PDF de tu carta.' },
      { status: 415 },
    );
  }

  if (archivo.size > MAX_BYTES) {
    return Response.json(
      {
        ok: false,
        error: `El archivo pesa demasiado (máximo ${Math.round(MAX_BYTES / 1024 / 1024)} MB). Toma la foto con menos resolución.`,
      },
      { status: 413 },
    );
  }

  try {
    const base64 = Buffer.from(await archivo.arrayBuffer()).toString('base64');
    const carta = await extraerCarta({ base64, mimeType: archivo.type });

    if (carta.productos.length === 0) {
      return Response.json(
        {
          ok: false,
          error:
            'No encontramos productos en esa imagen. Revisa que se vea la carta completa y con buena luz.',
        },
        { status: 422 },
      );
    }

    console.log('[catalog/extract] carta leída', {
      companyId: ctx.company.id,
      productos: carta.productos.length,
      necesitanRevision: carta.necesitanRevision,
    });

    return Response.json({ ok: true, ...carta });
  } catch (err) {
    console.error('[catalog/extract] error', err);
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'No pudimos leer la carta.' },
      { status: 502 },
    );
  }
});

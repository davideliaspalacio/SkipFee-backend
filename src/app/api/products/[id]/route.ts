import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  available: z.boolean().optional(),
  // nonnegative (no positive): permite $0 para productos de regalo.
  price: z.number().int().nonnegative().optional(),
  name: z.string().min(1).max(120).optional(),
  cat: z.string().min(1).max(60).optional(),
  img: z.string().max(1000).optional(),
  sold: z.number().int().nonnegative().optional(),
  // `nullable` para permitir limpiar la descripción explícitamente.
  description: z.string().max(500).nullable().optional(),
});

const STORAGE_BUCKET = 'product-images';

/**
 * Si la URL apunta al bucket de Storage, devuelve el path del objeto para
 * poder borrarlo. Si es URL externa (loremflickr u otra), devuelve null.
 *
 * Ejemplo:
 *   https://xxx.supabase.co/storage/v1/object/public/product-images/p01/123.jpg
 *   → "p01/123.jpg"
 */
function extractStoragePath(imgUrl: string | null | undefined): string | null {
  if (!imgUrl) return null;
  const marker = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
  const idx = imgUrl.indexOf(marker);
  if (idx < 0) return null;
  return imgUrl.slice(idx + marker.length);
}

/**
 * PATCH /api/products/:id
 * Permite al operario editar cualquier campo del producto desde Catálogo
 * (toggle disponibilidad, cambiar nombre/precio/categoría/imagen).
 * Solo campos provistos se actualizan.
 */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  let parsed;
  try {
    parsed = patchSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ ok: false, errors: err.issues }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  if (Object.keys(parsed).length === 0) {
    return Response.json({ ok: false, error: 'Sin campos para actualizar' }, { status: 400 });
  }

  // Normalizamos string vacío a null (igual que en POST) — el operario que
  // vacía el textarea espera "sin descripción", no un string vacío.
  const patch =
    typeof parsed.description === 'string' && !parsed.description.trim()
      ? { ...parsed, description: null }
      : parsed;

  const { data, error } = await supabaseAdmin()
    .from('products')
    .update(patch)
    .eq('id', id)
    .select('id, name, price, cat, sold, available, img, description')
    .single();

  if (error || !data) {
    return Response.json({ ok: false, error: 'Producto no encontrado' }, { status: 404 });
  }

  return Response.json({ ok: true, product: data });
}

/**
 * DELETE /api/products/:id
 * Soft-delete: el producto queda en BD con `archived=true` y `available=false`,
 * pero desaparece del catálogo admin, del menú del storefront, del bot y del
 * selector de promociones. No borramos físicamente porque order_items.product_id
 * apunta al producto y perderíamos el histórico de pedidos.
 *
 * La imagen del bucket sí se borra (best-effort) porque ya no se va a mostrar
 * y libera storage. Si se quiere "restaurar" después, hay que subir imagen nueva.
 */
export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const sb = supabaseAdmin();

  // 1. Buscar la imagen antes de archivar para limpiarla del bucket.
  const { data: existing } = await sb
    .from('products')
    .select('id, img')
    .eq('id', id)
    .maybeSingle();

  if (!existing) {
    return Response.json({ ok: false, error: 'Producto no encontrado' }, { status: 404 });
  }

  const { error: archErr } = await sb
    .from('products')
    .update({ archived: true, available: false, img: '' })
    .eq('id', id);
  if (archErr) {
    console.error('[products DELETE] archive error', archErr);
    return Response.json({ ok: false, error: archErr.message }, { status: 500 });
  }

  // 2. Best-effort: si la imagen estaba en nuestro bucket, borrarla — el
  // producto archivado ya no la usa.
  const path = extractStoragePath(existing.img as string | null);
  if (path) {
    const { error: rmErr } = await sb.storage.from(STORAGE_BUCKET).remove([path]);
    if (rmErr) console.error('[products DELETE] storage remove warn', rmErr);
  }

  return Response.json({ ok: true });
}

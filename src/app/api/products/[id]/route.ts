import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  available: z.boolean().optional(),
  price: z.number().int().positive().optional(),
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
 * Borra el producto del catálogo. Si tenía una imagen en nuestro bucket,
 * intenta borrarla (best-effort: si falla, igual se borra el producto).
 *
 * No bloqueamos si el producto está referenciado por `order_items` —
 * supabase mantiene la integridad referencial (lanza error si no se puede).
 */
export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const sb = supabaseAdmin();

  // 1. Buscar la imagen antes de borrar para limpiarla del bucket.
  const { data: existing } = await sb
    .from('products')
    .select('id, img')
    .eq('id', id)
    .maybeSingle();

  if (!existing) {
    return Response.json({ ok: false, error: 'Producto no encontrado' }, { status: 404 });
  }

  const { error: delErr } = await sb.from('products').delete().eq('id', id);
  if (delErr) {
    console.error('[products DELETE] error', delErr);
    return Response.json({ ok: false, error: delErr.message }, { status: 500 });
  }

  // 2. Best-effort: si la imagen estaba en nuestro bucket, borrarla.
  const path = extractStoragePath(existing.img as string | null);
  if (path) {
    const { error: rmErr } = await sb.storage.from(STORAGE_BUCKET).remove([path]);
    if (rmErr) console.error('[products DELETE] storage remove warn', rmErr);
  }

  return Response.json({ ok: true });
}

import { z } from 'zod';
import { withTenant } from '@/lib/tenant';
import { supabaseAdmin } from '@/lib/db';
import { PRECIO_MAX_COP, PRECIO_MIN_COP } from '@/lib/catalog/extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/<code>/catalog/import — guarda la carta ya revisada por el dueño.
 *
 * Segunda mitad del par de `/catalog/extract`: aquella lee, esta guarda. Están
 * separadas a propósito — entre las dos va la revisión humana, que es lo que
 * evita publicar un precio mal leído.
 *
 * `products.id` se genera con uuid (desde la 0027), así que dos empresas pueden
 * tener el mismo producto sin colisionar — a diferencia de lo que pasaba con
 * `zones.id` antes de la 0048.
 */

const productoSchema = z.object({
  nombre: z.string().min(1).max(160),
  descripcion: z.string().max(600).nullable().optional(),
  precio: z.number().int().min(PRECIO_MIN_COP).max(PRECIO_MAX_COP),
  categoria: z.string().min(1).max(60),
  disponible: z.boolean().optional(),
});

const bodySchema = z.object({
  productos: z.array(productoSchema).min(1).max(400),
  /** Archiva la carta anterior antes de importar. Para "volver a empezar". */
  reemplazar: z.boolean().optional(),
});

export const POST = withTenant(async (request, ctx) => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      {
        ok: false,
        error:
          'Revisa los productos: todos necesitan nombre, categoría y un precio entre ' +
          `$${PRECIO_MIN_COP.toLocaleString('es-CO')} y $${PRECIO_MAX_COP.toLocaleString('es-CO')}.`,
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const { productos, reemplazar } = parsed.data;
  const sb = supabaseAdmin();
  const companyId = ctx.company.id;

  // Archivar en vez de borrar: si el dueño se arrepiente, sus productos y el
  // historial de pedidos que los referencia siguen ahí.
  if (reemplazar) {
    const { error } = await sb
      .from('products')
      .update({ archived: true, available: false })
      .eq('company_id', companyId)
      .eq('archived', false);
    if (error) {
      console.error('[catalog/import] error archivando', error);
      return Response.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  const filas = productos.map(p => ({
    company_id: companyId,
    name: p.nombre.trim(),
    description: p.descripcion?.trim() || null,
    price: p.precio,
    cat: p.categoria.trim(),
    available: p.disponible ?? true,
    sold: 0,
    img: '',
    archived: false,
  }));

  const { data, error } = await sb.from('products').insert(filas).select('id');
  if (error) {
    console.error('[catalog/import] error insertando', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  // `settings.categories` alimenta los filtros del panel y de la tienda. Nace
  // vacío desde la 0049 (antes heredaba las de sandwichería del piloto), así
  // que se llena con las del rubro real.
  const categorias = [...new Set(productos.map(p => p.categoria.trim()))];
  const { data: actuales } = await sb
    .from('settings')
    .select('categories')
    .eq('company_id', companyId)
    .maybeSingle();

  // Al REEMPLAZAR la carta, las categorías también se reemplazan: si el negocio
  // cambió de rubro, dejar las viejas pegadas ensucia los filtros de la tienda
  // con secciones que ya no tienen ni un producto.
  const unidas = reemplazar
    ? categorias
    : [...new Set([...((actuales?.categories as string[]) ?? []), ...categorias])];
  await sb.from('settings').update({ categories: unidas }).eq('company_id', companyId);

  console.log('[catalog/import] carta guardada', {
    companyId,
    productos: data?.length ?? 0,
    categorias: categorias.length,
    reemplazo: !!reemplazar,
  });

  return Response.json(
    { ok: true, importados: data?.length ?? 0, categorias: unidas },
    { status: 201 },
  );
});

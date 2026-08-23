import type { NextRequest } from 'next/server';
import { isSlugAvailable, isValidSlug, slugify, suggestAvailableSlug } from '@/lib/provisioning';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/slug-available?name=... | ?slug=...
 *
 * Para que el formulario de registro muestre en vivo la dirección que le va a
 * quedar al negocio (`{slug}.skipfee.co`) y avise si está tomada ANTES de
 * enviar. Sin esto el usuario descubre el conflicto al final, que es donde
 * más se abandona.
 *
 * Público a propósito: solo revela si un slug está libre, que es información
 * que igual se deduce visitando la tienda.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const name = searchParams.get('name');
  const slug = searchParams.get('slug');

  if (slug) {
    if (!isValidSlug(slug)) {
      return Response.json({
        ok: true,
        slug,
        valid: false,
        available: false,
        reason: 'Solo minúsculas, números y guiones.',
      });
    }
    return Response.json({ ok: true, slug, valid: true, available: await isSlugAvailable(slug) });
  }

  if (name) {
    const suggestion = await suggestAvailableSlug(name);
    return Response.json({ ok: true, slug: slugify(name), valid: true, suggestion });
  }

  return Response.json({ ok: false, error: 'Indica `name` o `slug`.' }, { status: 400 });
}

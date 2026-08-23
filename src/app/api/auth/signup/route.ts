import type { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  emitirPaseDeEntrada,
  isValidSlug,
  provisionCompany,
  suggestAvailableSlug,
} from '@/lib/provisioning';
import {
  clientIp,
  isDisposableEmail,
  rateLimitSignup,
  verifyTurnstile,
} from '@/lib/signup-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/signup — REGISTRO PÚBLICO.
 *
 * Es la puerta de entrada del autoservicio: hasta ahora las cuentas las creaba
 * el owner desde `/api/platform/companies`, y no existía forma de que un
 * restaurante se diera de alta solo.
 *
 * Usa el MISMO motor que el owner (`provisionCompany`). La única diferencia es
 * si se exige confirmar el correo: el alta por owner lo marca como confirmado
 * porque él entrega las credenciales.
 *
 * ⚠️ **Verificación de correo apagada por ahora** (`SIGNUP_REQUIRE_EMAIL_CONFIRMATION`).
 * Todavía no hay servicio de envío de correos, así que exigir confirmación deja
 * al usuario en una pantalla de "revisa tu correo" ante un correo que nunca
 * llega: se registra y no puede entrar. Prendida es la defensa correcta —sin
 * ella cualquiera abre negocios con correos ajenos— así que el interruptor
 * queda listo: cuando haya proveedor de correo, `SIGNUP_REQUIRE_EMAIL_CONFIRMATION=true`
 * y vuelve sin tocar código.
 *
 * NO se pide tarjeta. Ninguno de los competidores verificados la pide en el
 * registro, y en Colombia solo el 23% de los adultos tiene tarjeta de crédito
 * — filtraría por el eje equivocado. Se pedirá al convertir.
 *
 * Defensas, de menor a mayor fricción (ver `lib/signup-guard.ts`):
 *   1. Turnstile (invisible)  2. correos desechables  3. rate limit por IP
 *   4. verificación del correo (hoy apagada)  5. Meta, al conectar el número
 */

const schema = z.object({
  businessName: z.string().min(2).max(120),
  email: z.string().email().max(200),
  password: z.string().min(8).max(72),
  /** Opcional: si no viene, se deriva del nombre y se resuelve el conflicto. */
  slug: z.string().min(2).max(63).optional(),
  turnstileToken: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'Revisa los datos', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { businessName, email, password, slug, turnstileToken } = parsed.data;

  // 1. Captcha invisible.
  if (!(await verifyTurnstile(turnstileToken))) {
    return Response.json(
      { ok: false, error: 'No pudimos verificar que eres una persona. Recarga e intenta de nuevo.' },
      { status: 400 },
    );
  }

  // 2. Correos desechables.
  if (isDisposableEmail(email)) {
    return Response.json(
      { ok: false, error: 'Usa un correo permanente: ahí te llegan los avisos de tus pedidos.' },
      { status: 400 },
    );
  }

  // 3. Rate limit por IP.
  const ip = clientIp(request.headers);
  const limit = rateLimitSignup(ip);
  if (!limit.allowed) {
    return Response.json(
      {
        ok: false,
        error: `Demasiados registros desde esta conexión. Intenta en ${limit.retryAfterMinutes} minutos.`,
      },
      { status: 429 },
    );
  }

  // 4. Slug: el que pidió, o uno derivado del nombre que esté libre.
  let finalSlug: string | null;
  if (slug) {
    if (!isValidSlug(slug)) {
      return Response.json(
        { ok: false, error: 'La dirección solo admite minúsculas, números y guiones.' },
        { status: 400 },
      );
    }
    finalSlug = slug;
  } else {
    finalSlug = await suggestAvailableSlug(businessName);
  }

  if (!finalSlug) {
    return Response.json(
      { ok: false, error: 'No pudimos generar una dirección para tu negocio. Elige una tú.' },
      { status: 409 },
    );
  }

  // 5. Alta atómica.
  //
  // El default es `false` a propósito: mientras no exista envío de correos, un
  // registro que exige confirmar es un registro que no deja entrar a nadie.
  const exigirConfirmacion = process.env.SIGNUP_REQUIRE_EMAIL_CONFIRMATION === 'true';

  const result = await provisionCompany({
    slug: finalSlug,
    name: businessName,
    superAdminEmail: email,
    superAdminPassword: password,
    requireEmailConfirmation: exigirConfirmacion,
  });

  if (!result.ok) {
    // El 409 de slug tomado se devuelve con una sugerencia, para que el
    // formulario pueda ofrecerla en vez de dejar al usuario atascado.
    if (result.status === 409) {
      return Response.json(
        {
          ok: false,
          error: 'Esa dirección ya está tomada.',
          suggestion: await suggestAvailableSlug(businessName),
        },
        { status: 409 },
      );
    }
    return Response.json({ ok: false, error: result.error }, { status: result.status });
  }

  // Pase de un solo uso para entrar directo al panel. Solo tiene sentido si la
  // cuenta ya sirve: con verificación de correo prendida, primero confirma.
  const pase = exigirConfirmacion ? null : await emitirPaseDeEntrada(email);

  console.log('[signup] empresa creada', {
    slug: result.company.slug,
    code: result.company.code,
    ip,
  });

  return Response.json(
    {
      ok: true,
      company: {
        slug: result.company.slug,
        code: result.company.code,
        name: result.company.name,
      },
      // Con la verificación apagada el usuario ya puede entrar con la
      // contraseña que acaba de elegir; con ella prendida, primero confirma.
      needsEmailConfirmation: exigirConfirmacion && !result.superAdmin.userAlreadyExisted,
      /** Pase de un solo uso: la landing lo lleva al panel y ahí se canjea. */
      pase,
      message: exigirConfirmacion
        ? 'Te mandamos un correo para confirmar tu cuenta.'
        : 'Tu cuenta está lista.',
    },
    { status: 201 },
  );
}

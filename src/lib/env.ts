import { z } from 'zod';

const schema = z.object({
  // --- Kapso ---
  KAPSO_API_KEY: z.string().min(1),
  KAPSO_WEBHOOK_SECRET: z.string().min(1),
  KAPSO_PHONE_NUMBER_ID: z.string().min(1),

  // --- Supabase ---
  // URL del proyecto, ej: https://xxxx.supabase.co
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  // Publishable (anon) — segura para compartir; respeta RLS.
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  // Service role — bypasea RLS. SOLO server. Nunca exponer al browser.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // --- Gemini ---
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),

  // --- Wompi (Widget Checkout Web) ---
  // En `mock` (default) el flujo sigue con la página /wompi/checkout/[orderId].
  // En `real` el POST /pay devuelve un widgetConfig que el frontend pasa al
  // Widget oficial (https://checkout.wompi.co/widget.js).
  // Las WOMPI_* son opcionales en el schema (para no romper el dev de quien aún
  // no las configuró). Se validan SÓLO en los handlers que las usan cuando MODE=real.
  WOMPI_MODE: z.enum(['mock', 'real']).default('mock'),
  WOMPI_API_BASE: z.string().url().default('https://sandbox.wompi.co/v1'),
  // Public key: se expone al frontend (también vía VITE_WOMPI_PUBLIC_KEY).
  WOMPI_PUBLIC_KEY: z.string().optional(),
  // Integrity secret: para firmar el widgetConfig (sha256 reference+amount+currency+secret).
  WOMPI_INTEGRITY_SECRET: z.string().optional(),
  // Events secret: para verificar la firma de los webhooks de Wompi.
  WOMPI_EVENTS_SECRET: z.string().optional(),
  // Private key: hoy no la usamos (el Widget cubre todo). Queda opcional por si en
  // el futuro necesitamos consultar transactions / refunds desde el backend.
  WOMPI_PRIVATE_KEY: z.string().optional(),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

function load(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment variables:\n${issues}\nCopy .env.example to .env.local and fill the values.`,
    );
  }
  cached = parsed.data;
  return cached;
}

/**
 * Validated environment access. Validation runs lazily on first property read,
 * so importing this module is safe at build time even when secrets aren't set.
 * Reading a value without the env configured throws with a clear message.
 */
export const env = new Proxy({} as Env, {
  get(_t, key: string) {
    return load()[key as keyof Env];
  },
});

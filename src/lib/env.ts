import { z } from 'zod';

const schema = z.object({
  // --- Kapso ---
  // Multi-empresa: las credenciales Kapso ahora viven POR EMPRESA en
  // `company_integrations` (ver `lib/integrations.ts`). Ya NO son requeridas en
  // el env global → el server arranca sin ellas. Usamos `.default('')` (no
  // `.optional()`) para que el tipo siga siendo `string` y los callers legacy
  // que aún las leen (`lib/kapso/*`, webhook Kapso sin migrar) compilen igual;
  // si faltan, las llamadas a Kapso fallarán en runtime (como antes con una
  // credencial inválida), pero el arranque no se rompe. La ruta correcta
  // multi-empresa es `kapsoFor(companyId)`.
  KAPSO_API_KEY: z.string().default(''),
  KAPSO_WEBHOOK_SECRET: z.string().default(''),
  KAPSO_PHONE_NUMBER_ID: z.string().default(''),

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

  // --- Google Maps (Geocoding server-side · Tarea 2) ---
  // Opcional para no romper el dev de quien no la configuró. Si falta, el bot
  // cae al camino manual de zona (no geocodifica). Requiere Geocoding API + billing.
  GOOGLE_MAPS_API_KEY: z.string().optional(),

  // --- Discord (aviso de leads de la landing) ---
  // Webhook al que POST /api/leads avisa cada pre-registro. Opcional: si falta,
  // el lead igual se guarda en Supabase y simplemente no se manda a Discord.
  DISCORD_WEBHOOK_URL: z.string().url().optional(),

  // --- Discord (aviso de visitas a la DEMO del panel) ---
  // Webhook para POST /api/demo-visit. Opcional: si falta, cae a DISCORD_WEBHOOK_URL.
  DISCORD_DEMO_WEBHOOK_URL: z.string().url().optional(),

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

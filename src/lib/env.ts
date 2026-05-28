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

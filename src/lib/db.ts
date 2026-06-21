import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * Cliente con service_role — bypasea RLS. Solo desde server (API routes / scripts).
 * Nunca exponer al browser ni shippear al frontend.
 */
let _admin: SupabaseClient | null = null;
export function supabaseAdmin(): SupabaseClient {
  if (_admin) return _admin;
  _admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _admin;
}

/**
 * Cliente con publishable (anon) key — respeta RLS. Útil si en algún momento
 * desde el backend queremos hacer operaciones "como anónimo" (raro).
 */
let _public: SupabaseClient | null = null;
export function supabasePublic(): SupabaseClient {
  if (_public) return _public;
  _public = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _public;
}

/**
 * Cliente con el JWT del usuario autenticado — **respeta RLS**.
 *
 * Multi-empresa: las rutas de negocio (admin/operación) consultan con ESTE
 * cliente, no con service_role. Así las policies de pertenencia (`tenant_all`,
 * `is_company_member`) actúan como segunda capa de aislamiento: aunque el código
 * olvide el `.eq('company_id', …)`, la BD impide leer/escribir filas de otra
 * empresa. service_role queda para rutas de sistema (webhooks, cron, bot).
 *
 * No se cachea: es por-request (el token cambia por usuario).
 */
export function supabaseForUser(accessToken: string): SupabaseClient {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

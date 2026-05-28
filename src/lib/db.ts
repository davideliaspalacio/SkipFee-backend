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

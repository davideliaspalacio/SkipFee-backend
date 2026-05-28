import { supabaseAdmin } from '@/lib/db';

/**
 * Registra el idempotency_key en webhook_events.
 * Si ya existe (unique_violation), devuelve duplicate=true y el caller debe saltarse el procesamiento.
 */
export async function recordIdempotency(opts: {
  idempotencyKey: string;
  type: string;
  payload: unknown;
}): Promise<{ duplicate: boolean }> {
  const { error } = await supabaseAdmin()
    .from('webhook_events')
    .insert({
      idempotency_key: opts.idempotencyKey,
      type: opts.type,
      payload: opts.payload as never,
    });

  // 23505 = unique_violation (PostgreSQL)
  if (error?.code === '23505') {
    return { duplicate: true };
  }
  if (error) throw error;
  return { duplicate: false };
}

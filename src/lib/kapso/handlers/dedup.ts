import { supabaseAdmin } from '@/lib/db';

/**
 * Registra el idempotency_key en webhook_events.
 * Si ya existe (unique_violation), devuelve duplicate=true y el caller debe saltarse el procesamiento.
 *
 * Multi-empresa: la dedup es POR EMPRESA. La PK de `webhook_events` pasó a ser
 * `(company_id, idempotency_key)`, así que el mismo idempotency_key en empresas
 * distintas no colisiona. `companyId` es OPCIONAL para no romper callers legacy
 * (caen a la empresa por defecto / comportamiento previo).
 */
export async function recordIdempotency(opts: {
  idempotencyKey: string;
  type: string;
  payload: unknown;
  companyId?: string;
}): Promise<{ duplicate: boolean }> {
  const { error } = await supabaseAdmin()
    .from('webhook_events')
    .insert({
      idempotency_key: opts.idempotencyKey,
      type: opts.type,
      payload: opts.payload as never,
      ...(opts.companyId ? { company_id: opts.companyId } : {}),
    });

  // 23505 = unique_violation (PostgreSQL)
  if (error?.code === '23505') {
    return { duplicate: true };
  }
  if (error) throw error;
  return { duplicate: false };
}

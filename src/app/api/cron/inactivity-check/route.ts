import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendText } from '@/lib/kapso/client';
import { recordMessage } from '@/lib/messaging';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/cron/inactivity-check
 *
 * Lo invoca pg_cron de Supabase cada minuto. Busca chats con flow_state
 * activo (status='bot', step != 'finalizado') donde:
 *
 * - last_message_at hace 5-30 min → manda nudge personalizado por step
 *   y marca como "ya recordado" para no spammear cada minuto
 * - last_message_at hace > 30 min → limpia el flow_state (sin mensaje,
 *   evita molestar a horas raras)
 *
 * Auth: header x-cron-secret debe coincidir con env.CRON_SECRET.
 * Si CRON_SECRET no está configurada, el endpoint responde 503 (no
 * queremos endpoint público para nudge automatizado).
 */

const NUDGE_AFTER_MIN = 5;
const RESET_AFTER_MIN = 30;

const NUDGES: Record<string, string> = {
  consentimiento: '¿Seguís ahí parce? Te quedó pendiente aceptar la política para que sigamos 🙏',
  menu_principal: '¿Seguís ahí? Tocá una opción del menú cuando quieras seguir con tu pedido 🥪',
  menu_recurrente: '¿Seguís ahí? Tocá una opción cuando quieras hacer el pedido 🥪',
  registro_nombre: '¿Seguís ahí? Cuando puedas, mandame tu nombre completo para arrancar tu pedido.',
  registro_email: '¿Seguís ahí? Falta tu correo para terminar el registro.',
  registro_confirmar: '¿Confirmás tus datos? Tocá "Sí, están bien" o "Editar".',
  ubicacion: '¿Seguís ahí? Decime en qué zona vas a recibir el pedido (lista del último mensaje).',
  direccion_texto: '¿Seguís ahí? Mandame la dirección completa para terminar tu pedido.',
  direccion_confirmar: '¿Confirmás la dirección? Tocá uno de los botones del último mensaje.',
  carta: '¿Seguís viendo la carta? Tocá un producto cuando quieras seguir.',
  cantidad: '¿Cuántos vas a querer? Botones 1, 2 o 3+ del último mensaje.',
  cantidad_custom: '¿Cuántos vas a querer? Mandame el número (entre 3 y 20).',
  algo_mas: '¿Seguís ahí? Tocá una opción del último mensaje para agregar más o cerrar el pedido.',
  resumen: '¿Confirmás el pedido? Tocá Confirmar, Editar o Cancelar.',
  resumen_editar: '¿Seguís editando el carrito? Tocá un item para quitarlo o "Listo" para volver al resumen.',
  pago: 'Te dejé el link de pago de Wompi. Cuando lo completes te confirmo y pasa a cocina 🥪',
};

interface ChatRow {
  id: string;
  phone: string;
  flow_state: {
    step?: string;
    reminderSentAt?: string;
  } | null;
  last_message_at: string;
}

export async function POST(request: NextRequest) {
  // 1. Auth
  const secret = request.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return Response.json({ ok: false, error: 'CRON_SECRET no configurado' }, { status: 503 });
  }
  if (secret !== expected) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const sb = supabaseAdmin();
  const now = new Date();
  const nudgeCutoff = new Date(now.getTime() - NUDGE_AFTER_MIN * 60_000).toISOString();
  const resetCutoff = new Date(now.getTime() - RESET_AFTER_MIN * 60_000).toISOString();

  // 2. Buscar chats candidatos: bot, flow_state existe, último mensaje > 5min
  // Filtramos en JS los step='finalizado' y los ya nudgeados.
  const { data: chats, error } = await sb
    .from('chats')
    .select('id, phone, flow_state, last_message_at')
    .eq('status', 'bot')
    .lt('last_message_at', nudgeCutoff)
    .not('flow_state', 'is', null);

  if (error) {
    console.error('[cron/inactivity-check] query error', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const candidates = (chats ?? []) as ChatRow[];
  let nudged = 0;
  let reset = 0;

  for (const chat of candidates) {
    const step = chat.flow_state?.step;
    if (!step || step === 'finalizado') continue;

    // ¿Llegó al reset de 30 min? Limpiamos el flow_state silenciosamente.
    if (chat.last_message_at < resetCutoff) {
      await sb
        .from('chats')
        .update({ flow_state: null, flow_updated_at: now.toISOString() })
        .eq('id', chat.id);
      reset++;
      continue;
    }

    // ¿Ya le mandamos nudge esta ronda? (evita re-recordarle cada minuto)
    if (chat.flow_state?.reminderSentAt) continue;

    const nudgeBody = NUDGES[step] ?? '¿Seguís ahí? Tocá una opción del último mensaje para seguir 🥪';

    try {
      const result = await sendText(chat.phone, nudgeBody);
      const wamid = result.messages?.[0]?.id ?? null;
      await recordMessage({
        phone: chat.phone,
        direction: 'bot',
        body: nudgeBody,
        kapsoMessageId: wamid,
      });

      // Marcar como nudgeado para no spamear cada minuto
      await sb
        .from('chats')
        .update({
          flow_state: { ...chat.flow_state, reminderSentAt: now.toISOString() },
        })
        .eq('id', chat.id);
      nudged++;
    } catch (err) {
      console.error('[cron/inactivity-check] nudge fail', { chatId: chat.id, err });
    }
  }

  // Touch env.NODE_ENV para que TypeScript no se queje del unused import
  void env.NODE_ENV;

  return Response.json({
    ok: true,
    checkedAt: now.toISOString(),
    candidates: candidates.length,
    nudged,
    reset,
  });
}

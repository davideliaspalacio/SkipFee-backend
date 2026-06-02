import type { FlowState } from './state';
import type { IncomingMessage } from './parser';
import { loadFlowState, saveFlowState } from './persistence';
import { detectPedirIntent } from './intent';
import {
  handleEntrada,
  handleMenu,
  handleConfirmarRecurrente,
  handleRegistroNombre,
  handleRegistroEmail,
  handleRegistroConfirmar,
  handleDireccionTexto,
  handleDireccionZona,
  handleDireccionConfirmar,
  handleLinkEnviado,
  iniciarPedido,
  escalarHumano,
  cancelarFlujo,
  type HandlerContext,
} from './handlers';

/**
 * Palabras clave que el cliente puede escribir en CUALQUIER step para escapar
 * del happy path. Se evalúan antes del dispatch del handler del step actual.
 *
 * - cancelar: limpia el flow_state y se despide; el chat sigue en modo bot
 * - humano/ayuda: transfiere el chat a status='human'; el bot deja de responder
 * - cambiar_dir: vuelve a direccion_texto (útil si el cliente ya tiene link y
 *   se dio cuenta de que se equivocó de dirección)
 */
const GLOBAL_KEYWORDS: Record<'cancelar' | 'humano' | 'ayuda' | 'cambiar_dir', string[]> = {
  cancelar: ['cancelar', 'cancel', 'salir', 'parar', 'stop', 'olvidalo', 'olvídalo'],
  humano: ['humano', 'asesor', 'persona', 'agente', 'operador', 'operadora'],
  ayuda: ['ayuda', 'help', 'no entiendo', 'no se', 'no sé'],
  cambiar_dir: ['cambiar direccion', 'cambiar dirección', 'cambiar la direccion', 'cambiar la dirección'],
};

function detectGlobalIntent(text: string | undefined): keyof typeof GLOBAL_KEYWORDS | null {
  if (!text) return null;
  const norm = text.toLowerCase().trim();
  if (norm.length === 0 || norm.length > 60) return null;
  for (const [intent, kws] of Object.entries(GLOBAL_KEYWORDS) as Array<[
    keyof typeof GLOBAL_KEYWORDS,
    string[],
  ]>) {
    if (kws.some(k => norm === k || norm.startsWith(k + ' '))) return intent;
  }
  return null;
}

/**
 * Orchestrator del state machine.
 *
 *   1. Cargar flow_state del chat (o vacío si nunca interactuó)
 *   2. Layer global: cancelar / humano / cambiar dirección
 *   3. Intención de pedir desde cualquier step (incl. "Quiero hacer un pedido"
 *      del botón de carrito vencido) → arranca el flujo de pedido
 *   4. Dispatch por step
 *   5. Guardar nuevo flow_state
 */
export async function processFlowMessage(opts: {
  chatId: string;
  phone: string;
  contactName?: string;
  message: IncomingMessage;
}): Promise<void> {
  const state = await loadFlowState(opts.chatId);
  const ctx: HandlerContext = {
    chatId: opts.chatId,
    phone: opts.phone,
    contactName: opts.contactName,
    state,
    incoming: opts.message,
  };

  const next = await routeFlow(ctx);
  await saveFlowState(opts.chatId, next);
}

export async function routeFlow(ctx: HandlerContext): Promise<FlowState> {
  const text = ctx.incoming.text;

  // 1. Keywords globales (solo sobre texto, no en button replies)
  const intent = text ? detectGlobalIntent(text) : null;
  if (intent === 'cancelar') return cancelarFlujo(ctx);
  if (intent === 'humano' || intent === 'ayuda') {
    return escalarHumano(ctx, `keyword: ${intent}`);
  }
  if (intent === 'cambiar_dir') {
    // Solo aplica si ya capturó datos antes (sino caería al flujo nuevo)
    const { handleConfirmarRecurrente: _unused } = await import('./handlers');
    const { default: ctxModule } = { default: ctx };
    const { sendText } = await import('@/lib/kapso/client');
    const { recordMessage } = await import('@/lib/messaging');
    // Mandar prompt y mover step a direccion_texto preservando customer.
    const body = '¿Cuál es tu *nueva dirección*? _(Ej: Cra 43A #5-15, apto 502)_';
    const result = await sendText(ctxModule.phone, body);
    const wamid = result.messages?.[0]?.id ?? null;
    await recordMessage({ phone: ctxModule.phone, direction: 'bot', body, kapsoMessageId: wamid });
    return { ...ctx.state, step: 'direccion_texto', delivery: { ...ctx.state.delivery, address: undefined } };
  }

  // 2. Intención de pedir desde cualquier step → arranca/reanuda el flujo
  //    de pedido. Cubre el texto exacto del botón de "carrito vencido".
  if (detectPedirIntent(text)) return iniciarPedido(ctx);

  // 3. Dispatch por step
  switch (ctx.state.step) {
    case 'menu':                 return handleMenu(ctx);
    case 'confirmar_recurrente': return handleConfirmarRecurrente(ctx);
    case 'registro_nombre':      return handleRegistroNombre(ctx);
    case 'registro_email':       return handleRegistroEmail(ctx);
    case 'registro_confirmar':   return handleRegistroConfirmar(ctx);
    case 'direccion_texto':      return handleDireccionTexto(ctx);
    case 'direccion_zona':       return handleDireccionZona(ctx);
    case 'direccion_confirmar':  return handleDireccionConfirmar(ctx);
    case 'link_enviado':         return handleLinkEnviado(ctx);
    case 'inicio':               return handleEntrada(ctx);
    case 'finalizado':           return handleEntrada(ctx);
    default:                     return handleEntrada(ctx);
  }
}

import type { FlowState } from './state';
import type { IncomingMessage } from './parser';
import { loadFlowState, saveFlowState } from './persistence';
import {
  handleEntrada,
  handleConsentimiento,
  handleMenuPrincipal,
  handleMenuRecurrente,
  handleRegistroNombre,
  handleRegistroEmail,
  handleRegistroConfirmar,
  handleUbicacion,
  handleDireccionTexto,
  handleDireccionConfirmar,
  handleCarta,
  handleCantidad,
  handleCantidadCustom,
  handleAlgoMas,
  handleResumen,
  handleResumenEditar,
  handlePago,
  handleFinalizado,
  escalarHumano,
  cancelarFlujo,
  type HandlerContext,
} from './handlers';

/**
 * Palabras clave que el cliente puede escribir en CUALQUIER step del flujo
 * para escapar del happy path. Se evalúan antes del dispatch del handler
 * del step actual.
 *
 * - cancelar: limpia el flow_state y se despide; el chat sigue en modo bot
 * - humano:   transfiere el chat a status='human'; el bot deja de responder
 * - ayuda:    también transfiere a humano (más simple que armar un menú
 *             contextual; lo podemos refinar después con un agente Gemini)
 */
const GLOBAL_KEYWORDS: Record<'cancelar' | 'humano' | 'ayuda', string[]> = {
  cancelar: ['cancelar', 'cancel', 'salir', 'parar', 'stop', 'olvidalo', 'olvídalo'],
  humano: ['humano', 'asesor', 'persona', 'agente', 'operador', 'operadora'],
  ayuda: ['ayuda', 'help', 'no entiendo', 'no se', 'no sé'],
};

function detectGlobalIntent(text: string | undefined): keyof typeof GLOBAL_KEYWORDS | null {
  if (!text) return null;
  const norm = text.toLowerCase().trim();
  if (norm.length === 0 || norm.length > 60) return null; // ignora mensajes largos
  for (const [intent, kws] of Object.entries(GLOBAL_KEYWORDS) as Array<[
    keyof typeof GLOBAL_KEYWORDS,
    string[],
  ]>) {
    if (kws.some(k => norm === k || norm.startsWith(k + ' '))) return intent;
  }
  return null;
}

/**
 * Orchestrator del state machine del bot.
 *
 * Cuando llega un mensaje al webhook, este es el punto de entrada
 * (si `chat.status === 'bot'`):
 *
 *   1. Cargar flow_state del chat (o vacío si nunca interactuó)
 *   2. Si nunca interactuó → handleEntrada (saludo + consentimiento)
 *   3. Si ya tiene step → despachar al handler correspondiente
 *   4. Guardar nuevo flow_state
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

  // Primera vez: no hemos pedido consentimiento aún
  const isFirstContact = !state.consentAskedAt && !state.consentGiven;
  let next: FlowState;
  if (isFirstContact) {
    next = await handleEntrada(ctx);
  } else {
    next = await dispatch(ctx);
  }

  await saveFlowState(opts.chatId, next);
}

async function dispatch(ctx: HandlerContext): Promise<FlowState> {
  // Layer global de keywords: aplica en cualquier step antes del handler.
  // Solo cuando el cliente escribe texto (no en button/list replies).
  const intent = ctx.incoming.text ? detectGlobalIntent(ctx.incoming.text) : null;
  if (intent === 'cancelar') return cancelarFlujo(ctx);
  if (intent === 'humano' || intent === 'ayuda') {
    return escalarHumano(ctx, `keyword: ${intent}`);
  }

  switch (ctx.state.step) {
    case 'consentimiento':       return handleConsentimiento(ctx);
    case 'menu_principal':       return handleMenuPrincipal(ctx);
    case 'menu_recurrente':      return handleMenuRecurrente(ctx);
    case 'registro_nombre':      return handleRegistroNombre(ctx);
    case 'registro_email':       return handleRegistroEmail(ctx);
    case 'registro_confirmar':   return handleRegistroConfirmar(ctx);
    case 'ubicacion':            return handleUbicacion(ctx);
    case 'direccion_texto':      return handleDireccionTexto(ctx);
    case 'direccion_confirmar':  return handleDireccionConfirmar(ctx);
    case 'carta':                return handleCarta(ctx);
    case 'cantidad':             return handleCantidad(ctx);
    case 'cantidad_custom':      return handleCantidadCustom(ctx);
    case 'algo_mas':             return handleAlgoMas(ctx);
    case 'resumen':              return handleResumen(ctx);
    case 'resumen_editar':       return handleResumenEditar(ctx);
    case 'pago':                 return handlePago(ctx);
    case 'finalizado':           return handleFinalizado(ctx);
    default:                     return handleEntrada(ctx);
  }
}

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
  handlePago,
  handleFinalizado,
  type HandlerContext,
} from './handlers';

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
    case 'pago':                 return handlePago(ctx);
    case 'finalizado':           return handleFinalizado(ctx);
    default:                     return handleEntrada(ctx);
  }
}

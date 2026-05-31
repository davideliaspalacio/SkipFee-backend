import type { FlowState } from './state';
import type { IncomingMessage } from './parser';
import { loadFlowState, saveFlowState } from './persistence';
import { detectPedirIntent } from './intent';
import {
  handleEntrada,
  handleMenu,
  handleLinkEnviado,
  enviarLinkPedido,
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
 * Orchestrator del state machine del bot mínimo.
 *
 *   1. Cargar flow_state del chat (o vacío si nunca interactuó)
 *   2. Layer global: cancelar / humano / ayuda
 *   3. Intención de pedir (texto, incl. "Quiero hacer un pedido" del botón de
 *      carrito vencido) en cualquier step → manda un link nuevo
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

/**
 * Decide qué handler corre para este mensaje. Separado de la persistencia para
 * poder testearlo. (Los handlers hacen su propio I/O — acá solo enrutamos.)
 */
export async function routeFlow(ctx: HandlerContext): Promise<FlowState> {
  const text = ctx.incoming.text;

  // 1. Keywords globales (solo sobre texto, no en button replies)
  const intent = text ? detectGlobalIntent(text) : null;
  if (intent === 'cancelar') return cancelarFlujo(ctx);
  if (intent === 'humano' || intent === 'ayuda') {
    return escalarHumano(ctx, `keyword: ${intent}`);
  }

  // 2. Intención de pedir desde cualquier step → link nuevo (sin fricción).
  //    Cubre el texto exacto del botón de "carrito vencido" de la tienda.
  if (detectPedirIntent(text)) return enviarLinkPedido(ctx);

  // 3. Dispatch por step
  switch (ctx.state.step) {
    case 'menu':          return handleMenu(ctx);
    case 'link_enviado':  return handleLinkEnviado(ctx);
    case 'inicio':        return handleEntrada(ctx);
    case 'finalizado':    return handleEntrada(ctx); // re-saluda y reinicia
    default:              return handleEntrada(ctx);
  }
}

import { sendText } from '@/lib/kapso/client';
import { recordMessage } from '@/lib/messaging';
import { getMessage, getKeywords } from '@/lib/bot/messages/catalog';
import { render } from '@/lib/bot/messages/render';
import { GLOBAL_KEYWORDS } from '@/lib/bot/messages/defaults';
import type { FlowState } from './state';
import type { IncomingMessage } from './parser';
import { loadFlowState, saveFlowState } from './persistence';
import { detectPedirIntent } from './intent';
import {
  handleEntrada,
  handleMenu,
  handlePedidoEnCurso,
  handleConfirmarRecurrente,
  handleRegistroNombre,
  handleRegistroEmail,
  handleRegistroConfirmar,
  handleDireccionTexto,
  handleDireccionZona,
  handleDireccionConfirmar,
  handleDireccionFueraCobertura,
  handleLinkEnviado,
  handlePostventaEncuesta,
  handlePostventaResena,
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
 *
 * Las listas son EDITABLES desde la UI (`keywords.*`); el default param de
 * `detectGlobalIntent` usa las del código y `routeFlow` le pasa las del catálogo.
 */
type GlobalIntent = 'cancelar' | 'humano' | 'ayuda' | 'cambiar_dir';
type GlobalKeywordMap = Record<GlobalIntent, readonly string[]>;

function detectGlobalIntent(
  text: string | undefined,
  keywords: GlobalKeywordMap = GLOBAL_KEYWORDS,
): GlobalIntent | null {
  if (!text) return null;
  const norm = text.toLowerCase().trim();
  if (norm.length === 0 || norm.length > 60) return null;
  for (const [intent, kws] of Object.entries(keywords) as Array<[GlobalIntent, readonly string[]]>) {
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

  // 1. Keywords globales (solo sobre texto, no en button replies). Editables.
  const globalKeywords: GlobalKeywordMap = {
    cancelar: await getKeywords('keywords.cancelar'),
    humano: await getKeywords('keywords.humano'),
    ayuda: await getKeywords('keywords.ayuda'),
    cambiar_dir: await getKeywords('keywords.cambiar_dir'),
  };
  const intent = text ? detectGlobalIntent(text, globalKeywords) : null;
  if (intent === 'cancelar') return cancelarFlujo(ctx);
  if (intent === 'humano' || intent === 'ayuda') {
    return escalarHumano(ctx, `keyword: ${intent}`);
  }
  if (intent === 'cambiar_dir') {
    // Solo aplica si ya capturó datos antes (sino caería al flujo nuevo).
    // Mandar prompt y mover step a direccion_texto preservando customer.
    const m = await getMessage('direccion.pedir_nueva');
    const body = render(m.body);
    const result = await sendText(ctx.phone, body);
    const wamid = result.messages?.[0]?.id ?? null;
    await recordMessage({ phone: ctx.phone, direction: 'bot', body, kapsoMessageId: wamid });
    return { ...ctx.state, step: 'direccion_texto', delivery: { ...ctx.state.delivery, address: undefined } };
  }

  // 2. Intención de pedir desde cualquier step → arranca/reanuda el flujo
  //    de pedido. Cubre el texto exacto del botón de "carrito vencido".
  //    (en 'pedido_en_curso' NO interceptamos: ese step maneja sus propios
  //    botones/texto; si interceptáramos, "otro pedido" por texto haría loop.)
  if (ctx.state.step !== 'pedido_en_curso' && detectPedirIntent(text, await getKeywords('keywords.pedir'))) return iniciarPedido(ctx);

  // 3. Dispatch por step
  switch (ctx.state.step) {
    case 'menu':                 return handleMenu(ctx);
    case 'pedido_en_curso':      return handlePedidoEnCurso(ctx);
    case 'confirmar_recurrente': return handleConfirmarRecurrente(ctx);
    case 'registro_nombre':      return handleRegistroNombre(ctx);
    case 'registro_email':       return handleRegistroEmail(ctx);
    case 'registro_confirmar':   return handleRegistroConfirmar(ctx);
    case 'direccion_texto':      return handleDireccionTexto(ctx);
    case 'direccion_zona':       return handleDireccionZona(ctx);
    case 'direccion_confirmar':  return handleDireccionConfirmar(ctx);
    case 'direccion_fuera_cobertura': return handleDireccionFueraCobertura(ctx);
    case 'link_enviado':         return handleLinkEnviado(ctx);
    case 'postventa_encuesta':   return handlePostventaEncuesta(ctx);
    case 'postventa_resena':     return handlePostventaResena(ctx);
    case 'inicio':               return handleEntrada(ctx);
    case 'finalizado':           return handleEntrada(ctx);
    default:                     return handleEntrada(ctx);
  }
}

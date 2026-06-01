import { supabaseAdmin } from '@/lib/db';
import { sendText } from '@/lib/kapso/client';
import { sendButtons, sendCtaUrl } from '@/lib/kapso/interactive';
import { recordMessage } from '@/lib/messaging';
import type { FlowState } from './state';
import { emptyFlowState } from './state';
import type { IncomingMessage } from './parser';
import { assistOffScript } from './gemini-fallback';

/**
 * Handlers del bot MÍNIMO. El bot ya no maneja carta/carrito/pago dentro de
 * WhatsApp: saluda, manda el link de la tienda web (`/pedir`) y hace seguimiento.
 *
 * Flujo: inicio (saludo) → menu (pedir / humano) → link_enviado → finalizado.
 */

export interface HandlerContext {
  chatId: string;
  phone: string;
  contactName?: string; // nombre que llegó del payload Kapso (puede no estar)
  state: FlowState;
  incoming: IncomingMessage;
}

/**
 * Envía un mensaje saliente vía Kapso Y lo persiste como direction='bot'.
 * Centraliza el wamid capture.
 */
async function botSendText(opts: { to: string; body: string }) {
  const result = await sendText(opts.to, opts.body);
  const wamid = result.messages?.[0]?.id ?? null;
  await recordMessage({
    phone: opts.to,
    direction: 'bot',
    body: opts.body,
    kapsoMessageId: wamid,
  });
}

async function botSendInteractive<T extends { messages?: Array<{ id?: string }> }>(opts: {
  to: string;
  preview: string;             // lo que persistimos como body (resumen para el panel)
  send: () => Promise<T>;
}) {
  const result = await opts.send();
  const wamid = result.messages?.[0]?.id ?? null;
  await recordMessage({
    phone: opts.to,
    direction: 'bot',
    body: opts.preview,
    kapsoMessageId: wamid,
  });
}

// =========================================================================
// ENTRADA — primer mensaje del cliente (sin consentimiento)
// =========================================================================

/**
 * Saluda (detectando si es cliente recurrente) y ofrece hacer el pedido.
 * Ya NO pide consentimiento: el primer contacto va directo al saludo + menú.
 */
export async function handleEntrada(ctx: HandlerContext): Promise<FlowState> {
  const { data: customer } = await supabaseAdmin()
    .from('customers')
    .select('name')
    .eq('phone', ctx.phone)
    .maybeSingle();

  const isReturning = customer !== null;
  const firstName =
    (customer?.name ?? ctx.contactName ?? '').split(' ')[0] || (isReturning ? 'parce' : '');
  const saludo = isReturning
    ? `¡Quihubo ${firstName}! 🥪 Qué bueno verte de nuevo.`
    : `${firstName ? `¡Quihubo ${firstName}!` : '¡Quihubo parce!'} 🥪 Soy el bot de Bros and Subs.`;

  await botSendInteractive({
    to: ctx.phone,
    preview: '[saludo + menú pedir]',
    send: () =>
      sendButtons({
        to: ctx.phone,
        body: `${saludo}\n¿Hacemos un pedido?`,
        buttons: [
          { id: 'menu_pedir', title: '🥪 Hacer pedido' },
          { id: 'menu_humano', title: '🙋 Hablar humano' },
        ],
      }),
  });

  return { ...emptyFlowState(), step: 'menu', isReturning };
}

// =========================================================================
// MENU — ¿pedir o humano?
// =========================================================================

export async function handleMenu(ctx: HandlerContext): Promise<FlowState> {
  const choice = ctx.incoming.buttonReplyId;
  if (choice === 'menu_pedir') return enviarLinkPedido(ctx);
  if (choice === 'menu_humano') return escalarHumano(ctx, 'cliente pidió humano desde el menú');

  // Texto libre que no matcheó intención de pedir (eso lo captura el router
  // antes): Gemini interpreta / reorienta y reenviamos el menú.
  return manejarTextoLibre({
    ctx,
    stepDescription: 'menú inicial del bot: el cliente decide si hacer un pedido o hablar con un humano',
    lastBotPrompt: '¿Hacemos un pedido? (botones: Hacer pedido / Hablar humano)',
    reprompt: () => reenviarMenu(ctx),
  });
}

// =========================================================================
// LINK ENVIADO — ya mandamos el link; esperando pago/seguimiento
// =========================================================================

export async function handleLinkEnviado(ctx: HandlerContext): Promise<FlowState> {
  // Si el cliente escribe acá (y no fue intención de pedir, que el router ya
  // habría capturado para reenviar un link nuevo), le recordamos el link.
  await botSendText({
    to: ctx.phone,
    body: 'Te dejé el link arriba para armar y pagar tu pedido 🛒 Apenas completes el pago te confirmo por acá. Si necesitás un humano, escribime *asesor*.',
  });
  return ctx.state;
}

// =========================================================================
// ENVIAR LINK DE PEDIDO — crea la sesión de checkout y manda el CTA URL
// =========================================================================

/**
 * Crea una orden borrador (sesión de checkout) y le manda al cliente el link de
 * la tienda web con un botón CTA URL. Reusa el endpoint interno
 * POST /api/checkout/sessions (misma lógica que el resto del bot, ej. crearPedido).
 */
export async function enviarLinkPedido(ctx: HandlerContext): Promise<FlowState> {
  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'http://localhost:3000';

  let url: string | null = null;
  let orderId: string | undefined;
  try {
    const res = await fetch(`${origin}/api/checkout/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: ctx.phone }),
    });
    const body = await res.json();
    if (body?.ok && typeof body.url === 'string') {
      url = body.url;
      orderId = body.orderId;
    } else {
      console.error('[bot] checkout sessions respondió error', body);
    }
  } catch (err) {
    console.error('[bot] error creando sesión de checkout', err);
  }

  if (!url) {
    await botSendText({
      to: ctx.phone,
      body: 'Uy, no pude generar tu link de pedido ahora mismo. Probá de nuevo en un momentito 🙏',
    });
    return { ...ctx.state, step: 'menu' };
  }

  await botSendInteractive({
    to: ctx.phone,
    preview: '[link tienda: ver carta y pedir]',
    send: () =>
      sendCtaUrl({
        to: ctx.phone,
        body: '¡Listo! 🥪 Armá tu pedido en nuestra tienda: elegís de la carta, ponés tu dirección y pagás. Apenas pagues te confirmo por acá.',
        displayText: 'Ver carta y pedir 🛒',
        url,
      }),
  });

  return { ...ctx.state, step: 'link_enviado', orderId };
}

// =========================================================================
// Helpers de escalado y reenvío
// =========================================================================

export async function escalarHumano(ctx: HandlerContext, razon: string): Promise<FlowState> {
  await supabaseAdmin().from('chats').update({ status: 'human' }).eq('id', ctx.chatId);
  console.log('[bot] escalado a humano', { chatId: ctx.chatId, razon });
  await botSendText({
    to: ctx.phone,
    body: 'Te paso con uno de mis compas humanos, ya te responde en un momentico 🙏',
  });
  return { ...ctx.state, step: 'finalizado' };
}

/**
 * Cancelación explícita por el cliente (palabra clave "cancelar" / "salir").
 * Limpia el flow_state y se despide. El chat sigue en modo bot — si el cliente
 * vuelve a saludar, arranca de cero.
 */
export async function cancelarFlujo(ctx: HandlerContext): Promise<FlowState> {
  console.log('[bot] flujo cancelado por el cliente', { chatId: ctx.chatId });
  await botSendText({
    to: ctx.phone,
    body: 'Listo, lo dejamos así. Cuando quieras pedir me escribís *pedir* y te paso el link 🥪',
  });
  return emptyFlowState();
}

/**
 * Manejo de texto libre cuando el cliente NO clickeó el botón esperado.
 * Gemini interpreta el mensaje y decide cancelar / escalar / continuar (con
 * respuesta clarificadora + reenvío del prompt original del step).
 */
export async function manejarTextoLibre(opts: {
  ctx: HandlerContext;
  stepDescription: string;
  lastBotPrompt: string;
  reprompt: () => Promise<FlowState>;
}): Promise<FlowState> {
  const userText = opts.ctx.incoming.text?.trim() ?? '';
  // Sin texto (ej. media) → solo reenviar el prompt
  if (!userText) return opts.reprompt();

  const result = await assistOffScript({
    stepDescription: opts.stepDescription,
    lastBotPrompt: opts.lastBotPrompt,
    userText,
  });

  if (result.intent === 'cancel') {
    await botSendText({ to: opts.ctx.phone, body: result.reply });
    return emptyFlowState();
  }
  if (result.intent === 'human') {
    await botSendText({ to: opts.ctx.phone, body: result.reply });
    await supabaseAdmin().from('chats').update({ status: 'human' }).eq('id', opts.ctx.chatId);
    return { ...opts.ctx.state, step: 'finalizado' };
  }

  // 'continue' → respondemos clarificación + reenviamos el prompt original
  await botSendText({ to: opts.ctx.phone, body: result.reply });
  return opts.reprompt();
}

/**
 * Manda un mensaje genérico de "tuve un problema" y escala a humano.
 * Lo invoca el webhook cuando processFlowMessage lanza una excepción no manejada.
 */
export async function manejarErrorInesperado(opts: {
  chatId: string;
  phone: string;
}): Promise<void> {
  try {
    await supabaseAdmin().from('chats').update({ status: 'human' }).eq('id', opts.chatId);
    await botSendText({
      to: opts.phone,
      body: 'Tuvimos un problema procesando tu mensaje. Te paso con uno de mis compas humanos 🙏',
    });
  } catch (err) {
    console.error('[bot] manejarErrorInesperado fallback fail', err);
  }
}

async function reenviarMenu(ctx: HandlerContext): Promise<FlowState> {
  await botSendInteractive({
    to: ctx.phone,
    preview: '[reenvío menú]',
    send: () =>
      sendButtons({
        to: ctx.phone,
        body: '¿Hacemos un pedido?',
        buttons: [
          { id: 'menu_pedir', title: '🥪 Hacer pedido' },
          { id: 'menu_humano', title: '🙋 Hablar humano' },
        ],
      }),
  });
  return { ...ctx.state, step: 'menu' };
}

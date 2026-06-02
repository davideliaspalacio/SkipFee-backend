import { supabaseAdmin } from '@/lib/db';
import { sendText } from '@/lib/kapso/client';
import { sendButtons, sendCtaUrl, sendList } from '@/lib/kapso/interactive';
import { recordMessage } from '@/lib/messaging';
import type { FlowState, FlowCustomer, FlowDelivery } from './state';
import { emptyFlowState } from './state';
import type { IncomingMessage } from './parser';
import { assistOffScript } from './gemini-fallback';

/**
 * Handlers del bot.
 *
 * Flujo: el bot captura nombre + email + dirección + zona por WhatsApp y solo
 * después manda el link de la tienda web. En la tienda el cliente solo elige
 * productos y paga con el Widget de Wompi — no llena formularios.
 *
 *   nuevo:       menu → registro_nombre → registro_email → registro_confirmar
 *                  → direccion_texto → direccion_zona → direccion_confirmar
 *                  → link_enviado → (pagado por webhook)
 *
 *   recurrente:  menu → confirmar_recurrente
 *                  → (Sí) link_enviado
 *                  → (Cambiar dir) direccion_texto → ...
 */

export interface HandlerContext {
  chatId: string;
  phone: string;
  contactName?: string; // nombre que llegó del payload Kapso (puede no estar)
  state: FlowState;
  incoming: IncomingMessage;
}

// =========================================================================
// Helpers de envío
// =========================================================================

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
  preview: string;
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
// ENTRADA — primer mensaje del cliente
// =========================================================================

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
  if (choice === 'menu_pedir') return iniciarPedido(ctx);
  if (choice === 'menu_humano') return escalarHumano(ctx, 'cliente pidió humano desde el menú');

  return manejarTextoLibre({
    ctx,
    stepDescription: 'menú inicial del bot: el cliente decide si hacer un pedido o hablar con un humano',
    lastBotPrompt: '¿Hacemos un pedido? (botones: Hacer pedido / Hablar humano)',
    reprompt: () => reenviarMenu(ctx),
  });
}

/**
 * Cliente quiere pedir: ¿recurrente o nuevo?
 * - Recurrente con datos completos → confirmar_recurrente (atajo)
 * - Nuevo o con datos incompletos → registro_intro (full flow)
 */
export async function iniciarPedido(ctx: HandlerContext): Promise<FlowState> {
  const { data: customer } = await supabaseAdmin()
    .from('customers')
    .select('id, name, email, addr, zone_id')
    .eq('phone', ctx.phone)
    .maybeSingle();

  const hasCompleteData =
    customer && customer.name && customer.addr && customer.zone_id;

  if (hasCompleteData) {
    const { data: zone } = await supabaseAdmin()
      .from('zones')
      .select('name, tarifa')
      .eq('id', customer.zone_id as string)
      .maybeSingle();

    await botSendInteractive({
      to: ctx.phone,
      preview: '[confirmar datos recurrente]',
      send: () =>
        sendButtons({
          to: ctx.phone,
          body:
            `¡Hola de nuevo, ${(customer.name as string).split(' ')[0]}! 👋\n` +
            `¿Pedimos a la misma dirección?\n\n` +
            `📍 ${customer.addr}\n` +
            `🗺️ ${zone?.name ?? customer.zone_id}` +
            (zone?.tarifa ? ` · domicilio $${formatCop(zone.tarifa as number)}` : ''),
          buttons: [
            { id: 'rec_si', title: '✅ Sí, igual' },
            { id: 'rec_cambiar', title: '✏️ Cambiar dir' },
          ],
        }),
    });

    return {
      ...ctx.state,
      step: 'confirmar_recurrente',
      isReturning: true,
      customer: {
        name: customer.name as string,
        email: (customer.email as string | null) ?? undefined,
      },
      delivery: {
        address: customer.addr as string,
        zoneId: customer.zone_id as string,
      },
    };
  }

  // Cliente nuevo → registro
  await botSendText({
    to: ctx.phone,
    body:
      'Veo que es la primera vez que nos escribes 🎉, necesito validar tus datos ' +
      'para saber si tienes cobertura y entregar tu orden. 😊\n' +
      'Si no deseas continuar, sólo escribe Salir.',
  });
  await botSendText({
    to: ctx.phone,
    body: '¿Cuál es tu *nombre completo*? _(Ej: Juan José González)_',
  });
  return { ...ctx.state, step: 'registro_nombre', customer: {}, delivery: {} };
}

// =========================================================================
// CONFIRMAR RECURRENTE — atajo del cliente con datos guardados
// =========================================================================

export async function handleConfirmarRecurrente(ctx: HandlerContext): Promise<FlowState> {
  const choice = ctx.incoming.buttonReplyId;
  if (choice === 'rec_si') return enviarLinkPedido(ctx);
  if (choice === 'rec_cambiar') {
    await botSendText({
      to: ctx.phone,
      body: '¿Cuál es tu *nueva dirección*? _(Ej: Cra 43A #5-15, apto 502)_',
    });
    return { ...ctx.state, step: 'direccion_texto' };
  }

  return manejarTextoLibre({
    ctx,
    stepDescription: 'el bot le preguntó al cliente recurrente si pedimos a la misma dirección guardada',
    lastBotPrompt: '¿Pedimos a la misma dirección? (botones: Sí, igual / Cambiar dir)',
    reprompt: () => iniciarPedido(ctx),
  });
}

// =========================================================================
// REGISTRO — nombre → email → confirmar
// =========================================================================

export async function handleRegistroNombre(ctx: HandlerContext): Promise<FlowState> {
  const text = ctx.incoming.text?.trim();
  if (!text || text.length < 2 || text.length > 120) {
    await botSendText({
      to: ctx.phone,
      body: 'Por favor escribime tu *nombre completo* _(entre 2 y 120 caracteres)_.',
    });
    return ctx.state;
  }

  await botSendText({ to: ctx.phone, body: '¡Gracias!' });
  await botSendText({
    to: ctx.phone,
    body: 'Para finalizar tu registro, ¿me permites tu *correo*? _(Ej: crepes@correo.com)_',
  });
  return {
    ...ctx.state,
    step: 'registro_email',
    customer: { ...ctx.state.customer, name: text },
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handleRegistroEmail(ctx: HandlerContext): Promise<FlowState> {
  const text = ctx.incoming.text?.trim();
  if (!text || !EMAIL_RE.test(text) || text.length > 200) {
    await botSendText({
      to: ctx.phone,
      body: 'Ese correo no es válido. Por favor escribilo en formato *nombre@correo.com*.',
    });
    return ctx.state;
  }

  const next: FlowCustomer = { ...ctx.state.customer, email: text };
  await botSendInteractive({
    to: ctx.phone,
    preview: '[confirmar registro nombre+email]',
    send: () =>
      sendButtons({
        to: ctx.phone,
        body:
          `Mira la información que guardé:\n` +
          `*Nombre:* ${next.name ?? '?'}\n` +
          `*Correo:* ${text}\n\n` +
          `¿Están correctos tus datos?`,
        buttons: [
          { id: 'reg_si', title: '✅ Sí' },
          { id: 'reg_no', title: '❌ No' },
        ],
      }),
  });
  return { ...ctx.state, step: 'registro_confirmar', customer: next };
}

export async function handleRegistroConfirmar(ctx: HandlerContext): Promise<FlowState> {
  const choice = ctx.incoming.buttonReplyId;
  if (choice === 'reg_si') {
    await botSendText({
      to: ctx.phone,
      body:
        '¡Perfecto! 🛵 Ahora necesito saber a dónde llevamos tu pedido.\n' +
        '¿Cuál es tu *dirección*? _(Ej: Cra 43A #5-15, apto 502)_',
    });
    return { ...ctx.state, step: 'direccion_texto' };
  }
  if (choice === 'reg_no') {
    await botSendText({
      to: ctx.phone,
      body: 'No hay drama. Empezamos de nuevo:\n¿Cuál es tu *nombre completo*?',
    });
    return { ...ctx.state, step: 'registro_nombre', customer: {} };
  }

  return manejarTextoLibre({
    ctx,
    stepDescription: 'el bot mostró un resumen de nombre+email y le pidió al cliente confirmar',
    lastBotPrompt: '¿Están correctos tus datos? (botones: Sí / No)',
    reprompt: async () => {
      // Reenviar el resumen
      const c = ctx.state.customer ?? {};
      await botSendInteractive({
        to: ctx.phone,
        preview: '[reenvío confirmar registro]',
        send: () =>
          sendButtons({
            to: ctx.phone,
            body: `*Nombre:* ${c.name ?? '?'}\n*Correo:* ${c.email ?? '?'}\n\n¿Están correctos?`,
            buttons: [
              { id: 'reg_si', title: '✅ Sí' },
              { id: 'reg_no', title: '❌ No' },
            ],
          }),
      });
      return ctx.state;
    },
  });
}

// =========================================================================
// DIRECCIÓN — texto → zona → confirmar
// =========================================================================

export async function handleDireccionTexto(ctx: HandlerContext): Promise<FlowState> {
  const text = ctx.incoming.text?.trim();
  if (!text || text.length < 5 || text.length > 500) {
    await botSendText({
      to: ctx.phone,
      body: 'Necesito una dirección un poco más detallada (mínimo 5 caracteres).',
    });
    return ctx.state;
  }

  // Cargar zonas activas para mostrarlas como lista.
  const { data: zones } = await supabaseAdmin()
    .from('zones')
    .select('id, name, tarifa')
    .order('name');
  const zonesList = (zones ?? []) as Array<{ id: string; name: string; tarifa: number }>;

  if (zonesList.length === 0) {
    await botSendText({
      to: ctx.phone,
      body: 'Uy, no tengo zonas configuradas todavía. Escribime *asesor* y te ayudo 🙏',
    });
    return ctx.state;
  }

  const next: FlowDelivery = { ...ctx.state.delivery, address: text };

  await botSendInteractive({
    to: ctx.phone,
    preview: '[lista de zonas]',
    send: () =>
      sendList({
        to: ctx.phone,
        body: '¿En qué *zona* queda? Tocá la opción que corresponde:',
        buttonText: 'Ver zonas',
        sections: [
          {
            rows: zonesList.map(z => ({
              id: `zone_${z.id}`,
              title: z.name,
              description: `Domicilio $${formatCop(z.tarifa)}`,
            })),
          },
        ],
      }),
  });
  return { ...ctx.state, step: 'direccion_zona', delivery: next };
}

export async function handleDireccionZona(ctx: HandlerContext): Promise<FlowState> {
  const listId = ctx.incoming.listReplyId;
  if (!listId || !listId.startsWith('zone_')) {
    return manejarTextoLibre({
      ctx,
      stepDescription: 'el bot le pidió al cliente elegir una zona de la lista de cobertura',
      lastBotPrompt: '¿En qué zona queda? (lista de zonas con tarifa)',
      reprompt: async () => {
        // Re-pedir la zona
        const { data: zones } = await supabaseAdmin()
          .from('zones')
          .select('id, name, tarifa')
          .order('name');
        const list = (zones ?? []) as Array<{ id: string; name: string; tarifa: number }>;
        await botSendInteractive({
          to: ctx.phone,
          preview: '[reenvío lista de zonas]',
          send: () =>
            sendList({
              to: ctx.phone,
              body: '¿En qué *zona* queda? Tocá la opción:',
              buttonText: 'Ver zonas',
              sections: [
                {
                  rows: list.map(z => ({
                    id: `zone_${z.id}`,
                    title: z.name,
                    description: `Domicilio $${formatCop(z.tarifa)}`,
                  })),
                },
              ],
            }),
        });
        return ctx.state;
      },
    });
  }

  const zoneId = listId.slice('zone_'.length);
  const { data: zone } = await supabaseAdmin()
    .from('zones')
    .select('id, name, tarifa')
    .eq('id', zoneId)
    .maybeSingle();

  if (!zone) {
    await botSendText({ to: ctx.phone, body: 'Zona no válida. Probá de nuevo.' });
    return ctx.state;
  }

  const next: FlowDelivery = { ...ctx.state.delivery, zoneId };

  await botSendInteractive({
    to: ctx.phone,
    preview: '[confirmar dirección + zona]',
    send: () =>
      sendButtons({
        to: ctx.phone,
        body:
          `Confirmo tu entrega:\n` +
          `📍 ${next.address}\n` +
          `🗺️ ${zone.name} · domicilio $${formatCop(zone.tarifa as number)}\n\n` +
          `¿Es correcta?`,
        buttons: [
          { id: 'dir_si', title: '✅ Sí, correcta' },
          { id: 'dir_editar', title: '✏️ Editar' },
        ],
      }),
  });
  return { ...ctx.state, step: 'direccion_confirmar', delivery: next };
}

export async function handleDireccionConfirmar(ctx: HandlerContext): Promise<FlowState> {
  const choice = ctx.incoming.buttonReplyId;
  if (choice === 'dir_si') return enviarLinkPedido(ctx);
  if (choice === 'dir_editar') {
    await botSendText({
      to: ctx.phone,
      body: 'Dale, escribime tu *dirección* de nuevo:',
    });
    return { ...ctx.state, step: 'direccion_texto', delivery: { ...ctx.state.delivery, address: undefined } };
  }

  return manejarTextoLibre({
    ctx,
    stepDescription: 'el bot mostró un resumen de dirección + zona y le pidió al cliente confirmar',
    lastBotPrompt: '¿La dirección es correcta? (botones: Sí, correcta / Editar)',
    reprompt: async () => {
      const d = ctx.state.delivery ?? {};
      await botSendInteractive({
        to: ctx.phone,
        preview: '[reenvío confirmar dirección]',
        send: () =>
          sendButtons({
            to: ctx.phone,
            body: `📍 ${d.address ?? '?'}\n🗺️ ${d.zoneId ?? '?'}\n\n¿Es correcta?`,
            buttons: [
              { id: 'dir_si', title: '✅ Sí, correcta' },
              { id: 'dir_editar', title: '✏️ Editar' },
            ],
          }),
      });
      return ctx.state;
    },
  });
}

// =========================================================================
// LINK ENVIADO — ya mandamos el link; esperando pago/seguimiento
// =========================================================================

export async function handleLinkEnviado(ctx: HandlerContext): Promise<FlowState> {
  await botSendText({
    to: ctx.phone,
    body:
      'Te dejé el link arriba para armar y pagar tu pedido 🛒\n' +
      'Apenas completes el pago te confirmo por acá. ' +
      'Si querés cambiar tu dirección escribime *cambiar dirección*.\n' +
      'Si necesitás un humano, escribime *asesor*.',
  });
  return ctx.state;
}

// =========================================================================
// ENVIAR LINK DE PEDIDO — crea sesión con datos y manda CTA URL
// =========================================================================

export async function enviarLinkPedido(ctx: HandlerContext): Promise<FlowState> {
  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'http://localhost:3000';
  const customer = ctx.state.customer;
  const delivery = ctx.state.delivery;

  const sessionPayload: Record<string, unknown> = { phone: ctx.phone };
  if (customer?.name) {
    sessionPayload.customer = {
      name: customer.name,
      ...(customer.email ? { email: customer.email } : {}),
    };
  }
  if (delivery?.address && delivery?.zoneId) {
    sessionPayload.delivery = { address: delivery.address, zoneId: delivery.zoneId };
  }

  let url: string | null = null;
  let orderId: string | undefined;
  try {
    const res = await fetch(`${origin}/api/checkout/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionPayload),
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
        body:
          '¡Listo! 🥪 Armá tu pedido en nuestra tienda: elegís de la carta y pagás. ' +
          'Apenas pagues te confirmo por acá.',
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

export async function cancelarFlujo(ctx: HandlerContext): Promise<FlowState> {
  console.log('[bot] flujo cancelado por el cliente', { chatId: ctx.chatId });
  await botSendText({
    to: ctx.phone,
    body: 'Listo, lo dejamos así. Cuando quieras pedir me escribís *pedir* y arrancamos 🥪',
  });
  return emptyFlowState();
}

export async function manejarTextoLibre(opts: {
  ctx: HandlerContext;
  stepDescription: string;
  lastBotPrompt: string;
  reprompt: () => Promise<FlowState>;
}): Promise<FlowState> {
  const userText = opts.ctx.incoming.text?.trim() ?? '';
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

  await botSendText({ to: opts.ctx.phone, body: result.reply });
  return opts.reprompt();
}

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

// =========================================================================
// Formateo
// =========================================================================

function formatCop(n: number): string {
  return n.toLocaleString('es-CO', { maximumFractionDigits: 0 });
}

import { supabaseAdmin } from '@/lib/db';
import { sendText } from '@/lib/kapso/client';
import { sendButtons, sendCtaUrl, sendList } from '@/lib/kapso/interactive';
import { recordMessage } from '@/lib/messaging';
import { getMessage } from '@/lib/bot/messages/catalog';
import { render, type RenderVars } from '@/lib/bot/messages/render';
import { loadOpenState } from '@/lib/hours';
import type { ButtonDef } from '@/lib/bot/messages/defaults';
import type { FlowState, FlowCustomer, FlowDelivery } from './state';
import { emptyFlowState } from './state';
import type { IncomingMessage } from './parser';
import { assistOffScript } from './gemini-fallback';

/**
 * Handlers del bot.
 *
 * Los TEXTOS de los mensajes ya no viven acá: se resuelven por `key` desde el
 * catálogo editable (`@/lib/bot/messages`). Con la tabla `bot_messages` vacía,
 * el catálogo cae a los defaults del código y el bot dice exactamente lo mismo.
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

/** Resuelve un mensaje de texto del catálogo, lo interpola y lo envía. */
async function sendCatalogText(to: string, key: string, vars: RenderVars = {}) {
  const m = await getMessage(key);
  await botSendText({ to, body: render(m.body, vars) });
}

function renderButtons(buttons: ButtonDef[] | undefined, vars: RenderVars = {}) {
  return (buttons ?? []).map(b => ({ id: b.id, title: render(b.title, vars) }));
}

/** Resuelve un mensaje de botones del catálogo, lo interpola y lo envía. */
async function sendCatalogButtons(opts: {
  to: string;
  key: string;
  vars?: RenderVars;
  preview: string;
}) {
  const m = await getMessage(opts.key);
  await botSendInteractive({
    to: opts.to,
    preview: opts.preview,
    send: () =>
      sendButtons({
        to: opts.to,
        body: render(m.body, opts.vars),
        buttons: renderButtons(m.buttons, opts.vars),
      }),
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
  // `parce` cubre el caso sin nombre tanto para nuevo como recurrente.
  const firstName =
    (customer?.name ?? ctx.contactName ?? '').split(' ')[0] || 'parce';

  const saludoMsg = await getMessage(isReturning ? 'saludo.recurrente' : 'saludo.nuevo');
  const menuMsg = await getMessage('menu.pedir');
  const body = `${render(saludoMsg.body, { nombre: firstName })}\n${render(menuMsg.body)}`;

  await botSendInteractive({
    to: ctx.phone,
    preview: '[saludo + menú pedir]',
    // Antes había también "🙋 Hablar humano" — lo quitamos para que el
    // primer touch sea exclusivamente comercial. Si un cliente igual
    // necesita atención humana puede escribirlo y `manejarTextoLibre`
    // lo escala vía `escalarHumano`.
    send: () =>
      sendButtons({
        to: ctx.phone,
        body,
        buttons: renderButtons(menuMsg.buttons),
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
  // `menu_humano` ya no se envía como botón en el saludo, pero seguimos
  // respetándolo por compat: si un cliente tiene el mensaje viejo en cache
  // de WhatsApp y aprieta, igual lo escalamos.
  if (choice === 'menu_humano') return escalarHumano(ctx, 'cliente pidió humano desde el menú');

  return manejarTextoLibre({
    ctx,
    stepDescription: 'menú inicial del bot: el cliente decide si hacer un pedido',
    lastBotPrompt: '¿Hacemos un pedido? (botón: Hacer pedido)',
    reprompt: () => reenviarMenu(ctx),
  });
}

/**
 * Cliente quiere pedir: ¿recurrente o nuevo?
 * - Recurrente con datos completos → confirmar_recurrente (atajo)
 * - Nuevo o con datos incompletos → registro_intro (full flow)
 */
export async function iniciarPedido(ctx: HandlerContext): Promise<FlowState> {
  // Gate por horario / pausa manual: no se inician pedidos fuera de horario.
  const openState = await loadOpenState(supabaseAdmin());
  if (!openState.open) {
    if (openState.paused) {
      await sendCatalogText(ctx.phone, 'cerrado.pausa');
    } else {
      await sendCatalogText(ctx.phone, 'cerrado.aviso', { apertura: openState.opensLabel ?? 'pronto' });
    }
    return { ...ctx.state, step: 'menu' };
  }

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

    await sendCatalogButtons({
      to: ctx.phone,
      key: 'recurrente.confirmar',
      preview: '[confirmar datos recurrente]',
      vars: {
        nombre: (customer.name as string).split(' ')[0],
        direccion: customer.addr as string,
        zona: (zone?.name as string) ?? (customer.zone_id as string),
        tarifa: zone?.tarifa ? formatCop(zone.tarifa as number) : '',
      },
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
  await sendCatalogText(ctx.phone, 'registro.intro');
  await sendCatalogText(ctx.phone, 'registro.pedir_nombre');
  return { ...ctx.state, step: 'registro_nombre', customer: {}, delivery: {} };
}

// =========================================================================
// CONFIRMAR RECURRENTE — atajo del cliente con datos guardados
// =========================================================================

export async function handleConfirmarRecurrente(ctx: HandlerContext): Promise<FlowState> {
  const choice = ctx.incoming.buttonReplyId;
  if (choice === 'rec_si') return enviarLinkPedido(ctx);
  if (choice === 'rec_cambiar') {
    await sendCatalogText(ctx.phone, 'direccion.pedir_nueva');
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
    await sendCatalogText(ctx.phone, 'registro.nombre_invalido');
    return ctx.state;
  }

  await sendCatalogText(ctx.phone, 'registro.gracias');
  await sendCatalogText(ctx.phone, 'registro.pedir_email');
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
    await sendCatalogText(ctx.phone, 'registro.email_invalido');
    return ctx.state;
  }

  const next: FlowCustomer = { ...ctx.state.customer, email: text };
  await sendCatalogButtons({
    to: ctx.phone,
    key: 'registro.confirmar',
    preview: '[confirmar registro nombre+email]',
    vars: { nombre: next.name ?? '?', correo: text },
  });
  return { ...ctx.state, step: 'registro_confirmar', customer: next };
}

export async function handleRegistroConfirmar(ctx: HandlerContext): Promise<FlowState> {
  const choice = ctx.incoming.buttonReplyId;
  if (choice === 'reg_si') {
    await sendCatalogText(ctx.phone, 'registro.confirmado_pedir_direccion');
    return { ...ctx.state, step: 'direccion_texto' };
  }
  if (choice === 'reg_no') {
    await sendCatalogText(ctx.phone, 'registro.reiniciar');
    return { ...ctx.state, step: 'registro_nombre', customer: {} };
  }

  return manejarTextoLibre({
    ctx,
    stepDescription: 'el bot mostró un resumen de nombre+email y le pidió al cliente confirmar',
    lastBotPrompt: '¿Están correctos tus datos? (botones: Sí / No)',
    reprompt: async () => {
      // Reenviar el resumen
      const c = ctx.state.customer ?? {};
      await sendCatalogButtons({
        to: ctx.phone,
        key: 'registro.confirmar',
        preview: '[reenvío confirmar registro]',
        vars: { nombre: c.name ?? '?', correo: c.email ?? '?' },
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
    await sendCatalogText(ctx.phone, 'direccion.invalida');
    return ctx.state;
  }

  // Cargar zonas activas (no archivadas) para mostrarlas como lista.
  const { data: zones } = await supabaseAdmin()
    .from('zones')
    .select('id, name, tarifa')
    .eq('archived', false)
    .order('name');
  const zonesList = (zones ?? []) as Array<{ id: string; name: string; tarifa: number }>;

  if (zonesList.length === 0) {
    await sendCatalogText(ctx.phone, 'direccion.sin_zonas');
    return ctx.state;
  }

  const next: FlowDelivery = { ...ctx.state.delivery, address: text };

  await sendZoneList(ctx.phone, zonesList, '[lista de zonas]');
  return { ...ctx.state, step: 'direccion_zona', delivery: next };
}

/** Envía la lista de zonas usando el mensaje editable `direccion.pedir_zona`. */
async function sendZoneList(
  to: string,
  zonesList: Array<{ id: string; name: string; tarifa: number }>,
  preview: string,
) {
  const m = await getMessage('direccion.pedir_zona');
  const rowTpl = m.rowDescriptionTemplate ?? 'Domicilio ${{tarifa}}';
  await botSendInteractive({
    to,
    preview,
    send: () =>
      sendList({
        to,
        body: render(m.body),
        buttonText: m.buttonText ?? 'Ver zonas',
        sections: [
          {
            rows: zonesList.map(z => ({
              id: `zone_${z.id}`,
              title: z.name,
              description: render(rowTpl, { tarifa: formatCop(z.tarifa) }),
            })),
          },
        ],
      }),
  });
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
          .eq('archived', false)
          .order('name');
        const list = (zones ?? []) as Array<{ id: string; name: string; tarifa: number }>;
        await sendZoneList(ctx.phone, list, '[reenvío lista de zonas]');
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
    await sendCatalogText(ctx.phone, 'direccion.zona_invalida');
    return ctx.state;
  }

  const next: FlowDelivery = { ...ctx.state.delivery, zoneId };

  await sendCatalogButtons({
    to: ctx.phone,
    key: 'direccion.confirmar',
    preview: '[confirmar dirección + zona]',
    vars: {
      direccion: next.address ?? '',
      zona: zone.name as string,
      tarifa: formatCop(zone.tarifa as number),
    },
  });
  return { ...ctx.state, step: 'direccion_confirmar', delivery: next };
}

export async function handleDireccionConfirmar(ctx: HandlerContext): Promise<FlowState> {
  const choice = ctx.incoming.buttonReplyId;
  if (choice === 'dir_si') return enviarLinkPedido(ctx);
  if (choice === 'dir_editar') {
    await sendCatalogText(ctx.phone, 'direccion.reeditar');
    return { ...ctx.state, step: 'direccion_texto', delivery: { ...ctx.state.delivery, address: undefined } };
  }

  return manejarTextoLibre({
    ctx,
    stepDescription: 'el bot mostró un resumen de dirección + zona y le pidió al cliente confirmar',
    lastBotPrompt: '¿La dirección es correcta? (botones: Sí, correcta / Editar)',
    reprompt: async () => {
      const d = ctx.state.delivery ?? {};
      await sendCatalogButtons({
        to: ctx.phone,
        key: 'direccion.confirmar',
        preview: '[reenvío confirmar dirección]',
        vars: { direccion: d.address ?? '?', zona: d.zoneId ?? '?', tarifa: '' },
      });
      return ctx.state;
    },
  });
}

// =========================================================================
// LINK ENVIADO — ya mandamos el link; esperando pago/seguimiento
// =========================================================================

export async function handleLinkEnviado(ctx: HandlerContext): Promise<FlowState> {
  await sendCatalogText(ctx.phone, 'link.post_envio');
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
    await sendCatalogText(ctx.phone, 'link.error');
    return { ...ctx.state, step: 'menu' };
  }

  const linkMsg = await getMessage('link.enviar');
  await botSendInteractive({
    to: ctx.phone,
    preview: '[link tienda: ver carta y pedir]',
    send: () =>
      sendCtaUrl({
        to: ctx.phone,
        body: render(linkMsg.body),
        displayText: linkMsg.displayText ?? 'Ver carta y pedir 🛒',
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
  await sendCatalogText(ctx.phone, 'humano.escalar');
  return { ...ctx.state, step: 'finalizado' };
}

export async function cancelarFlujo(ctx: HandlerContext): Promise<FlowState> {
  console.log('[bot] flujo cancelado por el cliente', { chatId: ctx.chatId });
  await sendCatalogText(ctx.phone, 'flujo.cancelar');
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
    await sendCatalogText(opts.phone, 'error.inesperado');
  } catch (err) {
    console.error('[bot] manejarErrorInesperado fallback fail', err);
  }
}

async function reenviarMenu(ctx: HandlerContext): Promise<FlowState> {
  // En sync con el menú inicial: solo "Hacer pedido" (sin el saludo).
  await sendCatalogButtons({
    to: ctx.phone,
    key: 'menu.pedir',
    preview: '[reenvío menú]',
  });
  return { ...ctx.state, step: 'menu' };
}

// =========================================================================
// Formateo
// =========================================================================

function formatCop(n: number): string {
  return n.toLocaleString('es-CO', { maximumFractionDigits: 0 });
}

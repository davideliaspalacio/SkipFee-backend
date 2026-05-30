import { supabaseAdmin } from '@/lib/db';
import { sendText } from '@/lib/kapso/client';
import { sendButtons, sendList, sendCtaUrl } from '@/lib/kapso/interactive';
import { recordMessage } from '@/lib/messaging';
import { bogotaTime, isWithinRange } from '@/lib/pricing';
import type { FlowState } from './state';
import { emptyFlowState } from './state';
import type { IncomingMessage } from './parser';
import { assistOffScript } from './gemini-fallback';

const PRIVACY_POLICY_URL = 'https://brosandsubs.com/politica-datos';
const MAX_CART_ITEMS = 20;

const COP = (n: number) => '$' + new Intl.NumberFormat('es-CO').format(Math.round(n));

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
// ENTRADA — primer mensaje del cliente
// =========================================================================

export async function handleEntrada(ctx: HandlerContext): Promise<FlowState> {
  // Detectar si es cliente recurrente (existe en customers)
  const { data: customer } = await supabaseAdmin()
    .from('customers')
    .select('id, name, addr, zone_id, email, lat, lng, pedidos')
    .eq('phone', ctx.phone)
    .maybeSingle();

  const isReturning = customer !== null;

  // Caso 1: nuevo → saludo + política de datos
  if (!isReturning) {
    const greeting = ctx.contactName ? `¡Quihubo ${ctx.contactName.split(' ')[0]}!` : '¡Quihubo parce!';
    const body = `${greeting} 🥪 Soy el bot de Bros and Subs.\n\nAntes de seguir, ¿estás de acuerdo con nuestra política de tratamiento de datos?\n${PRIVACY_POLICY_URL}`;
    await botSendInteractive({
      to: ctx.phone,
      preview: '[saludo + consentimiento]',
      send: () =>
        sendButtons({
          to: ctx.phone,
          body,
          buttons: [
            { id: 'consent_yes', title: '✅ Sí, acepto' },
            { id: 'consent_no', title: '❌ No' },
          ],
        }),
    });
    return {
      ...emptyFlowState(),
      consentAskedAt: new Date().toISOString(),
      isReturning: false,
    };
  }

  // Caso 2: recurrente → saludo y opciones de "repetir / nuevo / cambiar dir"
  const firstName = (customer?.name ?? '').split(' ')[0] || 'parce';
  const body = `¡Quihubo ${firstName}! 🥪 Qué bueno verte de nuevo.\n¿Querés hacer un pedido?`;
  await botSendInteractive({
    to: ctx.phone,
    preview: '[saludo recurrente]',
    send: () =>
      sendButtons({
        to: ctx.phone,
        body,
        buttons: [
          { id: 'rec_nuevo', title: '🥪 Nuevo pedido' },
          { id: 'rec_carta', title: '📋 Ver carta' },
          { id: 'rec_humano', title: '🙋 Hablar c/ alguien' },
        ],
      }),
  });
  return {
    ...emptyFlowState(),
    step: 'menu_recurrente',
    consentGiven: true,
    isReturning: true,
    customer: {
      name: customer.name,
      email: customer.email ?? undefined,
      address: customer.addr,
      lat: customer.lat ?? undefined,
      lng: customer.lng ?? undefined,
      zoneId: customer.zone_id,
    },
  };
}

// =========================================================================
// CONSENTIMIENTO
// =========================================================================

export async function handleConsentimiento(ctx: HandlerContext): Promise<FlowState> {
  if (ctx.incoming.buttonReplyId === 'consent_yes') {
    await botSendInteractive({
      to: ctx.phone,
      preview: '[menú principal]',
      send: () =>
        sendButtons({
          to: ctx.phone,
          body: '¡Perfecto! 😊 ¿Cómo te ayudo?',
          buttons: [
            { id: 'menu_pedir', title: '🥪 Pedir' },
            { id: 'menu_carta', title: '📋 Ver carta' },
            { id: 'menu_humano', title: '🙋 Humano' },
          ],
        }),
    });
    return { ...ctx.state, consentGiven: true, step: 'menu_principal' };
  }

  if (ctx.incoming.buttonReplyId === 'consent_no') {
    await botSendText({
      to: ctx.phone,
      body: 'Sin problema parce, cuando cambies de opinión por acá estamos 👋',
    });
    return { ...emptyFlowState(), step: 'finalizado' };
  }

  // No respondió con botón — reenviar prompt
  await botSendInteractive({
    to: ctx.phone,
    preview: '[reenvío consentimiento]',
    send: () =>
      sendButtons({
        to: ctx.phone,
        body: `Para seguir necesito que me confirmes si aceptas la política:\n${PRIVACY_POLICY_URL}`,
        buttons: [
          { id: 'consent_yes', title: '✅ Sí, acepto' },
          { id: 'consent_no', title: '❌ No' },
        ],
      }),
  });
  return ctx.state;
}

// =========================================================================
// MENU PRINCIPAL (cliente nuevo)
// =========================================================================

export async function handleMenuPrincipal(ctx: HandlerContext): Promise<FlowState> {
  const choice = ctx.incoming.buttonReplyId;
  if (choice === 'menu_pedir') {
    await botSendText({
      to: ctx.phone,
      body: '¡Bien! Como es tu primera vez por acá, necesito tu nombre completo. ¿Cómo te llamás?',
    });
    return { ...ctx.state, step: 'registro_nombre' };
  }
  if (choice === 'menu_carta') {
    await mostrarCartaTexto(ctx);
    // Después de mostrar la carta, volvemos al menú
    await botSendInteractive({
      to: ctx.phone,
      preview: '[menú principal post-carta]',
      send: () =>
        sendButtons({
          to: ctx.phone,
          body: '¿Querés pedir algo?',
          buttons: [
            { id: 'menu_pedir', title: '🥪 Sí, pedir' },
            { id: 'menu_humano', title: '🙋 Humano' },
          ],
        }),
    });
    return ctx.state; // sigue en menu_principal
  }
  if (choice === 'menu_humano') {
    return escalarHumano(ctx, 'cliente pidió hablar con humano desde menú');
  }
  // Texto libre o botón desconocido → Gemini interpreta o reenvía
  return manejarTextoLibre({
    ctx,
    stepDescription: 'menú principal con opciones Pedir / Ver carta / Humano',
    lastBotPrompt: '¡Perfecto! 😊 ¿Cómo te ayudo? (botones: Pedir, Ver carta, Humano)',
    reprompt: () => reenviarMenu(ctx),
  });
}

// =========================================================================
// MENU RECURRENTE
// =========================================================================

export async function handleMenuRecurrente(ctx: HandlerContext): Promise<FlowState> {
  const choice = ctx.incoming.buttonReplyId;
  if (choice === 'rec_nuevo') {
    // Cliente recurrente, ya tenemos sus datos. Saltamos registro y vamos a confirmar dirección.
    const addr = ctx.state.customer.address;
    if (addr) {
      await botSendInteractive({
        to: ctx.phone,
        preview: '[confirmar dirección guardada]',
        send: () =>
          sendButtons({
            to: ctx.phone,
            body: `¿Te lo mando a la dirección de siempre?\n📍 ${addr}`,
            buttons: [
              { id: 'addr_misma', title: '✅ Sí, misma' },
              { id: 'addr_nueva', title: '📍 Otra dirección' },
            ],
          }),
      });
      return { ...ctx.state, step: 'direccion_confirmar' };
    }
    // No tiene dirección guardada → pedirla
    await pedirUbicacion(ctx);
    return { ...ctx.state, step: 'ubicacion' };
  }
  if (choice === 'rec_carta') {
    await mostrarCartaTexto(ctx);
    return ctx.state;
  }
  if (choice === 'rec_humano') {
    return escalarHumano(ctx, 'cliente recurrente pidió humano');
  }
  return ctx.state;
}

// =========================================================================
// REGISTRO (nombre → email → confirmar)
// =========================================================================

export async function handleRegistroNombre(ctx: HandlerContext): Promise<FlowState> {
  const text = ctx.incoming.text?.trim();
  if (!text || text.length < 3 || text.length > 80) {
    await botSendText({
      to: ctx.phone,
      body: 'Pasame tu nombre completo en un mensaje, parce. Ej: Andrés Felipe Ochoa',
    });
    return ctx.state;
  }
  await botSendText({ to: ctx.phone, body: `¡Gracias ${text.split(' ')[0]}! Ahora pasame tu correo. Ej: tucorreo@gmail.com` });
  return {
    ...ctx.state,
    step: 'registro_email',
    customer: { ...ctx.state.customer, name: text },
  };
}

export async function handleRegistroEmail(ctx: HandlerContext): Promise<FlowState> {
  const email = ctx.incoming.text?.trim().toLowerCase();
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRe.test(email)) {
    await botSendText({
      to: ctx.phone,
      body: 'Ese correo no me cuadra. Mandame uno válido, ej: tucorreo@gmail.com',
    });
    return ctx.state;
  }
  const customer = { ...ctx.state.customer, email };
  await botSendInteractive({
    to: ctx.phone,
    preview: '[confirmar datos registro]',
    send: () =>
      sendButtons({
        to: ctx.phone,
        body: `Confirmame que están bien:\n👤 ${customer.name}\n✉️ ${customer.email}`,
        buttons: [
          { id: 'reg_ok', title: '✅ Sí, están bien' },
          { id: 'reg_edit', title: '✏️ Editar' },
        ],
      }),
  });
  return { ...ctx.state, step: 'registro_confirmar', customer };
}

export async function handleRegistroConfirmar(ctx: HandlerContext): Promise<FlowState> {
  const choice = ctx.incoming.buttonReplyId;
  if (choice === 'reg_ok') {
    await pedirUbicacion(ctx);
    return { ...ctx.state, step: 'ubicacion' };
  }
  if (choice === 'reg_edit') {
    await botSendText({ to: ctx.phone, body: 'Listo, empecemos de nuevo. ¿Cómo te llamás?' });
    return { ...ctx.state, step: 'registro_nombre', customer: {} };
  }
  return ctx.state;
}

// =========================================================================
// ZONA — pedimos zona con List en vez de ubicación nativa
// (el SDK de Kapso tiene un bug con sendInteractiveLocationRequest)
// =========================================================================

async function pedirUbicacion(ctx: HandlerContext) {
  await botSendInteractive({
    to: ctx.phone,
    preview: '[pedir zona]',
    send: () =>
      sendList({
        to: ctx.phone,
        body: '¡Genial! 📍 ¿En qué zona vas a recibir el pedido?',
        buttonText: 'Elegir zona',
        sections: [{
          title: 'Zonas con cobertura',
          rows: [
            { id: 'zona_poblado',  title: 'El Poblado',  description: 'Domicilio $4.500' },
            { id: 'zona_envigado', title: 'Envigado',    description: 'Domicilio $5.500' },
            { id: 'zona_laureles', title: 'Laureles',    description: 'Domicilio $5.000' },
            { id: 'zona_fatima',   title: 'Fátima',      description: 'Domicilio $6.000' },
            { id: 'zona_otra',     title: 'Otra zona',   description: 'Te paso con un humano' },
          ],
        }],
      }),
  });
}

export async function handleUbicacion(ctx: HandlerContext): Promise<FlowState> {
  const rowId = ctx.incoming.listReplyId;
  if (rowId === 'zona_otra') {
    return escalarHumano(ctx, 'cliente eligió "otra zona"');
  }
  const zoneMap: Record<string, string> = {
    zona_poblado: 'poblado',
    zona_envigado: 'envigado',
    zona_laureles: 'laureles',
    zona_fatima: 'fatima',
  };
  const zoneId = rowId ? zoneMap[rowId] : null;
  if (!zoneId) {
    await pedirUbicacion(ctx);
    return ctx.state;
  }
  await botSendText({
    to: ctx.phone,
    body: `Perfecto 🛵 Ahora pasame la *dirección completa* con interior/apartamento/torre.\n_Ej: Cra 35 #8-71, apto 301_`,
  });
  return {
    ...ctx.state,
    step: 'direccion_texto',
    customer: { ...ctx.state.customer, zoneId },
  };
}

// =========================================================================
// DIRECCIÓN TEXTO + CONFIRMAR
// =========================================================================

export async function handleDireccionTexto(ctx: HandlerContext): Promise<FlowState> {
  const text = ctx.incoming.text?.trim();
  if (!text || text.length < 10) {
    await botSendText({
      to: ctx.phone,
      body: 'La dirección está muy corta. Pasame algo más detallado, parce 🙏',
    });
    return ctx.state;
  }
  const newState: FlowState = {
    ...ctx.state,
    customer: { ...ctx.state.customer, address: text },
  };
  if (ctx.state.isReturning) {
    // recurrente sin dirección guardada o que pidió otra dirección
    await botSendInteractive({
      to: ctx.phone,
      preview: '[confirmar dirección]',
      send: () =>
        sendButtons({
          to: ctx.phone,
          body: `¿Es esta?\n📍 ${text}`,
          buttons: [
            { id: 'addr_ok_save', title: '✅ Sí y guardar' },
            { id: 'addr_edit', title: '✏️ Cambiar' },
            { id: 'addr_ok_nosave', title: '⚠️ Sí, sin guardar' },
          ],
        }),
    });
  } else {
    await botSendInteractive({
      to: ctx.phone,
      preview: '[confirmar dirección]',
      send: () =>
        sendButtons({
          to: ctx.phone,
          body: `¿Es esta?\n📍 ${text}`,
          buttons: [
            { id: 'addr_ok_save', title: '✅ Sí y guardar' },
            { id: 'addr_edit', title: '✏️ Cambiar' },
            { id: 'addr_ok_nosave', title: '⚠️ Sí, sin guardar' },
          ],
        }),
    });
  }
  return { ...newState, step: 'direccion_confirmar' };
}

export async function handleDireccionConfirmar(ctx: HandlerContext): Promise<FlowState> {
  const choice = ctx.incoming.buttonReplyId;
  if (choice === 'addr_ok_save' || choice === 'addr_ok_nosave' || choice === 'addr_misma') {
    const saveAddress = choice === 'addr_ok_save';
    // Avanzar a la carta
    await mostrarCartaList(ctx);
    return {
      ...ctx.state,
      step: 'carta',
      customer: { ...ctx.state.customer, saveAddress },
    };
  }
  if (choice === 'addr_edit' || choice === 'addr_nueva') {
    await botSendText({
      to: ctx.phone,
      body: 'Listo, pasame la dirección correcta en un mensaje.',
    });
    return { ...ctx.state, step: 'direccion_texto' };
  }
  return ctx.state;
}

// =========================================================================
// CARTA — list message con secciones
// =========================================================================

async function mostrarCartaTexto(ctx: HandlerContext) {
  const { data: products } = await supabaseAdmin()
    .from('products')
    .select('id, name, price, cat')
    .eq('available', true)
    .order('cat')
    .order('name');

  const grouped = new Map<string, Array<{ name: string; price: number }>>();
  for (const p of products ?? []) {
    const arr = grouped.get(p.cat) ?? [];
    arr.push({ name: p.name, price: p.price });
    grouped.set(p.cat, arr);
  }
  let text = '📋 *Nuestra carta*\n';
  for (const [cat, items] of grouped.entries()) {
    text += `\n*${cat}*\n`;
    for (const it of items) text += `• ${it.name} — ${COP(it.price)}\n`;
  }
  await botSendText({ to: ctx.phone, body: text });
}

async function mostrarCartaList(ctx: HandlerContext) {
  const { data: products } = await supabaseAdmin()
    .from('products')
    .select('id, name, price, cat')
    .eq('available', true)
    .order('cat')
    .order('name');

  // WhatsApp limita a 10 filas en total. Para que entre, mostramos las categorías
  // como secciones y agarramos las top 10 más vendidas. Para MVP simplificamos:
  // tomamos máximo 10 productos priorizando sándwiches.
  const all = products ?? [];
  const top = all.slice(0, 10);
  const byCategory = new Map<string, Array<{ id: string; name: string; price: number }>>();
  for (const p of top) {
    const arr = byCategory.get(p.cat) ?? [];
    arr.push({ id: p.id, name: p.name, price: p.price });
    byCategory.set(p.cat, arr);
  }
  const sections = Array.from(byCategory.entries()).map(([title, rows]) => ({
    title,
    rows: rows.map(r => ({
      id: `prod_${r.id}`,
      title: r.name.slice(0, 24),
      description: COP(r.price),
    })),
  }));

  await botSendInteractive({
    to: ctx.phone,
    preview: '[mostrar carta]',
    send: () =>
      sendList({
        to: ctx.phone,
        body: 'Mirá lo que tenemos disponible:',
        buttonText: 'Ver carta',
        sections,
      }),
  });
}

export async function handleCarta(ctx: HandlerContext): Promise<FlowState> {
  const rowId = ctx.incoming.listReplyId;
  if (!rowId || !rowId.startsWith('prod_')) {
    await mostrarCartaList(ctx);
    return ctx.state;
  }
  const productId = rowId.replace(/^prod_/, '');

  // Cargar producto para tener nombre + precio + foto en el mensaje de cantidad
  const { data: product } = await supabaseAdmin()
    .from('products')
    .select('id, name, price, img')
    .eq('id', productId)
    .single();

  const body = product
    ? `*${product.name}* — ${COP(product.price)}\n¿Cuántos vas a querer?`
    : '¿Cuántos vas a querer?';

  await botSendInteractive({
    to: ctx.phone,
    preview: `[pedir cantidad ${product?.name ?? ''}]`,
    send: () =>
      sendButtons({
        to: ctx.phone,
        body,
        buttons: [
          { id: 'qty_1', title: '1' },
          { id: 'qty_2', title: '2' },
          { id: 'qty_3', title: '3+' },
        ],
        header: product?.img ? { type: 'image', imageUrl: product.img } : undefined,
      }),
  });
  return { ...ctx.state, step: 'cantidad', cart: { ...ctx.state.cart, pendingProductId: productId } };
}

// =========================================================================
// CANTIDAD
// =========================================================================

export async function handleCantidad(ctx: HandlerContext): Promise<FlowState> {
  const productId = ctx.state.cart.pendingProductId;
  if (!productId) {
    await mostrarCartaList(ctx);
    return { ...ctx.state, step: 'carta' };
  }
  const choice = ctx.incoming.buttonReplyId;

  // "3+" abre un sub-step que pide el número exacto por texto.
  // Los botones 1 y 2 sí setean qty directamente.
  if (choice === 'qty_3') {
    await botSendText({
      to: ctx.phone,
      body: '¿Cuántos vas a querer? Mandame el número (entre 3 y 20):',
    });
    return { ...ctx.state, step: 'cantidad_custom' };
  }

  let qty: number | null = null;
  if (choice === 'qty_1') qty = 1;
  else if (choice === 'qty_2') qty = 2;
  else if (ctx.incoming.text) {
    const n = parseInt(ctx.incoming.text.replace(/[^\d]/g, ''), 10);
    if (!isNaN(n) && n > 0 && n <= 20) qty = n;
  }

  if (!qty) {
    await botSendText({ to: ctx.phone, body: 'Elegí cuántos vas a querer (1, 2, o 3+):' });
    return ctx.state;
  }

  return agregarItemYContinuar(ctx, productId, qty);
}

/**
 * Step que aparece cuando el cliente clickeó "3+" en handleCantidad.
 * Espera que escriba un número (3-20). Si manda otra cosa, re-pide.
 */
export async function handleCantidadCustom(ctx: HandlerContext): Promise<FlowState> {
  const productId = ctx.state.cart.pendingProductId;
  if (!productId) {
    await mostrarCartaList(ctx);
    return { ...ctx.state, step: 'carta' };
  }

  const text = ctx.incoming.text ?? '';
  const n = parseInt(text.replace(/[^\d]/g, ''), 10);

  if (isNaN(n) || n < 1 || n > 20) {
    await botSendText({
      to: ctx.phone,
      body: 'Necesito un número entre 1 y 20. Mandalo así:  *5*',
    });
    return ctx.state;
  }

  return agregarItemYContinuar(ctx, productId, n);
}

/**
 * Helper compartido por handleCantidad y handleCantidadCustom.
 * Busca el producto, lo agrega al carrito y pasa al step 'algo_mas'.
 * Si el carrito llegó al máximo, salta directo al resumen.
 */
async function agregarItemYContinuar(
  ctx: HandlerContext,
  productId: string,
  qty: number,
): Promise<FlowState> {
  const { data: product } = await supabaseAdmin()
    .from('products')
    .select('id, name, price')
    .eq('id', productId)
    .single();
  if (!product) {
    await botSendText({ to: ctx.phone, body: 'Ups, ese producto ya no está disponible. Volvamos a la carta.' });
    await mostrarCartaList(ctx);
    return { ...ctx.state, step: 'carta', cart: { ...ctx.state.cart, pendingProductId: undefined } };
  }

  const newItems = [...ctx.state.cart.items, { productId: product.id, name: product.name, qty, price: product.price }];
  if (newItems.length >= MAX_CART_ITEMS) {
    await botSendText({ to: ctx.phone, body: 'Llegamos al máximo del carrito. Vamos al pago.' });
    return mostrarResumen(
      { ...ctx.state, cart: { items: newItems, pendingProductId: undefined } },
      ctx,
    );
  }

  await botSendInteractive({
    to: ctx.phone,
    preview: '[¿algo más?]',
    send: () =>
      sendButtons({
        to: ctx.phone,
        body: `Listo, ${qty}× ${product.name} agregados 🥪 ¿Algo más?`,
        buttons: [
          { id: 'mas_si', title: '➕ Agregar más' },
          { id: 'mas_no', title: '✅ Continuar' },
        ],
      }),
  });
  return {
    ...ctx.state,
    step: 'algo_mas',
    cart: { items: newItems, pendingProductId: undefined },
  };
}

// =========================================================================
// ALGO MÁS
// =========================================================================

export async function handleAlgoMas(ctx: HandlerContext): Promise<FlowState> {
  const choice = ctx.incoming.buttonReplyId;
  if (choice === 'mas_si') {
    await mostrarCartaList(ctx);
    return { ...ctx.state, step: 'carta' };
  }
  if (choice === 'mas_no') {
    return mostrarResumen(ctx.state, ctx);
  }
  // Texto libre o botón desconocido → Gemini interpreta o reenvía
  return manejarTextoLibre({
    ctx,
    stepDescription: `cliente armando carrito, ya tiene ${ctx.state.cart.items.length} producto(s) y debe decidir si agregar más o continuar al pago`,
    lastBotPrompt: '¿Algo más? Botones: Agregar más / Continuar al pago.',
    reprompt: async () => {
      await botSendInteractive({
        to: ctx.phone,
        preview: '[reenvío ¿algo más?]',
        send: () =>
          sendButtons({
            to: ctx.phone,
            body: '¿Algo más?',
            buttons: [
              { id: 'mas_si', title: '➕ Agregar más' },
              { id: 'mas_no', title: '✅ Continuar' },
            ],
          }),
      });
      return ctx.state;
    },
  });
}

// =========================================================================
// RESUMEN → PAGO
// =========================================================================

async function mostrarResumen(state: FlowState, ctx: HandlerContext): Promise<FlowState> {
  // Calcular total
  const subtotal = state.cart.items.reduce((s, it) => s + it.price * it.qty, 0);
  const { data: zone } = await supabaseAdmin()
    .from('zones')
    .select('tarifa, recargo')
    .eq('id', state.customer.zoneId ?? '')
    .single();
  const { data: settings } = await supabaseAdmin()
    .from('settings')
    .select('peak_start, peak_end, base_delivery_fee')
    .eq('id', 1)
    .single();

  const baseDelivery = zone?.tarifa ?? settings?.base_delivery_fee ?? 4500;
  const isPeak = isWithinRange(bogotaTime(), settings?.peak_start ?? null, settings?.peak_end ?? null);
  const peakSurcharge = isPeak ? (zone?.recargo ?? 0) : 0;
  const total = subtotal + baseDelivery + peakSurcharge;

  let body = '🥪 *Tu pedido:*\n';
  for (const it of state.cart.items) {
    body += `• ${it.qty}× ${it.name} — ${COP(it.price * it.qty)}\n`;
  }
  body += `\n📍 ${state.customer.address}\n`;
  body += `💵 Subtotal: ${COP(subtotal)}\n`;
  body += `🛵 Domicilio: ${COP(baseDelivery)}`;
  if (peakSurcharge > 0) body += ` (+${COP(peakSurcharge)} hora pico)`;
  body += `\n*Total: ${COP(total)}*\n\n¿Confirmamos?`;

  await botSendInteractive({
    to: ctx.phone,
    preview: '[resumen pedido]',
    send: () =>
      sendButtons({
        to: ctx.phone,
        body,
        buttons: [
          { id: 'pay_yes', title: '✅ Confirmar' },
          { id: 'pay_no', title: '❌ Cancelar' },
        ],
      }),
  });
  return { ...state, step: 'resumen' };
}

export async function handleResumen(ctx: HandlerContext): Promise<FlowState> {
  const choice = ctx.incoming.buttonReplyId;
  if (choice === 'pay_no') {
    await botSendText({ to: ctx.phone, body: 'Listo parce, lo cancelamos. Cuando quieras pedir de nuevo me escribís 👋' });
    return { ...emptyFlowState(), step: 'finalizado' };
  }
  if (choice !== 'pay_yes') {
    // Texto libre o botón desconocido → Gemini interpreta o reenvía el resumen
    return manejarTextoLibre({
      ctx,
      stepDescription: 'cliente revisando el resumen del pedido antes del pago',
      lastBotPrompt: 'Resumen del pedido + total. Dos botones: Confirmar / Cancelar.',
      reprompt: () => mostrarResumen(ctx.state, ctx),
    });
  }

  // Crear el pedido vía endpoint interno
  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'http://localhost:3000';
  const res = await fetch(`${origin}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: {
        name: ctx.state.customer.name ?? ctx.contactName ?? 'Cliente WhatsApp',
        phone: ctx.phone,
        addr: ctx.state.customer.address ?? '',
      },
      zoneId: ctx.state.customer.zoneId,
      items: ctx.state.cart.items.map(i => ({ productId: i.productId, qty: i.qty })),
      paymentMethod: 'Wompi · Pendiente',
    }),
  });
  const body = await res.json();
  if (!body.ok) {
    await botSendText({ to: ctx.phone, body: `Hubo un problema creando el pedido: ${body.error ?? 'reintenta más tarde'}. Te paso con un humano.` });
    return escalarHumano(ctx, `error crear pedido: ${body.error ?? 'desconocido'}`);
  }

  // Persistir cambios en customers si pidió guardar
  if (ctx.state.customer.saveAddress && ctx.state.customer.address) {
    await supabaseAdmin()
      .from('customers')
      .update({
        addr: ctx.state.customer.address,
        zone_id: ctx.state.customer.zoneId,
        lat: ctx.state.customer.lat,
        lng: ctx.state.customer.lng,
        email: ctx.state.customer.email,
      })
      .eq('phone', ctx.phone);
  }

  // Mandar link de pago con el número visible del pedido
  const orderLabel = body.orderNumber ? `#${String(body.orderNumber).padStart(3, '0')}` : '';
  await botSendInteractive({
    to: ctx.phone,
    preview: '[link pago Wompi]',
    send: () =>
      sendCtaUrl({
        to: ctx.phone,
        body: `¡Excelente! 🎉 Tu pedido ${orderLabel} quedó listo.\nApenas completes el pago te confirmo y pasa a cocina 🥪`,
        displayText: '💳 Pagar con Wompi',
        url: body.paymentLink,
      }),
  });
  return {
    ...ctx.state,
    step: 'pago',
    orderId: body.orderId,
  };
}

// =========================================================================
// PAGO (esperando webhook Wompi). Si el cliente escribe acá:
// =========================================================================

export async function handlePago(ctx: HandlerContext): Promise<FlowState> {
  await botSendText({
    to: ctx.phone,
    body: 'Tu pedido está esperando que completes el pago en el link que te mandé. Cuando lo recibamos te aviso 🙌',
  });
  return ctx.state;
}

export async function handleFinalizado(ctx: HandlerContext): Promise<FlowState> {
  // Si el cliente escribe después de finalizado, empezamos de cero
  return handleEntrada(ctx);
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
 * Limpia el flow_state y se despide con un mensaje cordial. El chat sigue
 * en modo bot — si el cliente vuelve a saludar, arranca de cero.
 */
export async function cancelarFlujo(ctx: HandlerContext): Promise<FlowState> {
  console.log('[bot] flujo cancelado por el cliente', { chatId: ctx.chatId });
  await botSendText({
    to: ctx.phone,
    body: 'Listo, lo dejamos así. Cuando quieras retomar me escribís y empezamos de cero 🥪',
  });
  return emptyFlowState();
}

/**
 * Manejo de texto libre cuando el cliente NO clickeó el botón/list esperado.
 * Llama a Gemini para interpretar el mensaje y decidir si cancelar, escalar
 * o continuar (con respuesta clarificadora + reenvío del prompt original).
 *
 * Los handlers lo invocan en lugar de devolver `ctx.state` mudo. El caller
 * pasa una función `reprompt` que vuelve a mostrar el prompt original del
 * step (botones / list / pregunta), para que después de la respuesta del
 * bot el cliente sepa cómo seguir.
 */
export async function manejarTextoLibre(opts: {
  ctx: HandlerContext;
  stepDescription: string;
  lastBotPrompt: string;
  reprompt: () => Promise<FlowState>;
}): Promise<FlowState> {
  const userText = opts.ctx.incoming.text?.trim() ?? '';
  // Sin texto (ej. media, ubicación) → solo reenviar el prompt
  if (!userText) return opts.reprompt();

  const result = await assistOffScript({
    stepDescription: opts.stepDescription,
    lastBotPrompt: opts.lastBotPrompt,
    userText,
  });

  if (result.intent === 'cancel') {
    // Reusamos el mensaje del modelo si fue distinto al genérico de cancelarFlujo
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
 * Lo invoca el webhook cuando processFlowMessage lanza una excepción que
 * NO fue manejada por ningún handler.
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
    // Si esto también falla no hay mucho que hacer; al menos el log queda
    console.error('[bot] manejarErrorInesperado fallback fail', err);
  }
}

async function reenviarMenu(ctx: HandlerContext): Promise<FlowState> {
  await botSendInteractive({
    to: ctx.phone,
    preview: '[reenvío menú principal]',
    send: () =>
      sendButtons({
        to: ctx.phone,
        body: 'Decime cómo te ayudo:',
        buttons: [
          { id: 'menu_pedir', title: '🥪 Pedir' },
          { id: 'menu_carta', title: '📋 Ver carta' },
          { id: 'menu_humano', title: '🙋 Humano' },
        ],
      }),
  });
  return ctx.state;
}

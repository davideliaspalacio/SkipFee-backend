import { Type, type FunctionDeclaration } from '@google/genai';
import { supabaseAdmin } from '@/lib/db';
import { createBotOrder } from '@/lib/bot/orders';
import { compareCategories } from '@/lib/categories';

/**
 * Definiciones de tools que Gemini puede invocar.
 * Las exporto separadas para usarlas en el SDK.
 */

export const toolDefinitions: FunctionDeclaration[] = [
  {
    name: 'consultarCarta',
    description:
      'Devuelve los productos disponibles agrupados por categoría (sándwiches, bebidas, postres, combos). ' +
      'Úsala cuando el cliente pregunte qué hay, qué venden, o pida ver el menú.',
    parametersJsonSchema: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'cotizarPedido',
    description:
      'Calcula el subtotal, domicilio y total de un pedido tentativo. ' +
      'Úsala antes de cerrar para confirmar al cliente cuánto va a pagar. ' +
      'Si conoces la zona, pásala; si no, devuelve tarifa base.',
    parametersJsonSchema: {
      type: Type.OBJECT,
      properties: {
        items: {
          type: Type.ARRAY,
          description: 'Lista de productos con sus cantidades',
          items: {
            type: Type.OBJECT,
            properties: {
              productId: { type: Type.STRING, description: 'ID del producto, ej. p01' },
              qty: { type: Type.INTEGER, description: 'Cantidad' },
            },
            required: ['productId', 'qty'],
          },
        },
        zoneId: {
          type: Type.STRING,
          description: 'ID de la zona (poblado, envigado, laureles, fatima) — opcional',
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'crearPedido',
    description:
      'Crea el pedido en estado "nuevo" y devuelve el link de pago Wompi. ' +
      'Úsala SOLO cuando el cliente confirme explícitamente que quiere proceder con el pago.',
    parametersJsonSchema: {
      type: Type.OBJECT,
      properties: {
        customerName: { type: Type.STRING, description: 'Nombre completo del cliente' },
        phone: { type: Type.STRING, description: 'Teléfono E.164 sin "+", ej. 573013589021' },
        address: { type: Type.STRING, description: 'Dirección completa de entrega' },
        zoneId: {
          type: Type.STRING,
          description: 'ID de la zona (poblado, envigado, laureles, fatima)',
        },
        items: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              productId: { type: Type.STRING },
              qty: { type: Type.INTEGER },
            },
            required: ['productId', 'qty'],
          },
        },
        paymentMethod: {
          type: Type.STRING,
          description: 'Método de pago: "Wompi · Tarjeta" o "Wompi · PSE"',
        },
      },
      required: ['customerName', 'phone', 'address', 'zoneId', 'items', 'paymentMethod'],
    },
  },
  {
    name: 'escalarAHumano',
    description:
      'Marca el chat como "human" para que un operario tome la conversación. ' +
      'Úsala cuando: (a) el cliente pide hablar con humano, (b) se queja de algo serio, ' +
      '(c) hace una pregunta fuera del scope del bot, o (d) detectás frustración.',
    parametersJsonSchema: {
      type: Type.OBJECT,
      properties: {
        razon: {
          type: Type.STRING,
          description: 'Por qué escalas (queda en logs para el operario).',
        },
      },
      required: ['razon'],
    },
  },
];

// =========================================================================
// Implementaciones de los tools (las ejecuta el agent loop)
// =========================================================================

export async function consultarCarta(companyId?: string): Promise<unknown> {
  const sb = supabaseAdmin();
  let query = sb
    .from('products')
    .select('id, name, price, cat')
    .eq('available', true)
    .eq('archived', false);
  if (companyId) query = query.eq('company_id', companyId);
  // Fila de settings: por empresa; fallback legacy a la fila única id=1.
  let settingsQuery = sb.from('settings').select('categories');
  settingsQuery = companyId ? settingsQuery.eq('company_id', companyId) : settingsQuery.eq('id', 1);
  const [{ data, error }, { data: settings }] = await Promise.all([
    query.order('cat').order('name'),
    settingsQuery.maybeSingle(),
  ]);
  if (error) return { ok: false, error: error.message };

  const byCategory = new Map<string, Array<{ id: string; name: string; price: number }>>();
  for (const p of data ?? []) {
    const list = byCategory.get(p.cat) ?? [];
    list.push({ id: p.id, name: p.name, price: p.price });
    byCategory.set(p.cat, list);
  }
  // Carta en el orden que el restaurante configuró (Configuración → Categorías).
  const compare = compareCategories(((settings?.categories as string[] | null) ?? []));
  return {
    ok: true,
    categories: Array.from(byCategory.entries())
      .sort(([a], [b]) => compare(a, b))
      .map(([cat, items]) => ({ cat, items })),
  };
}

export async function cotizarPedido(args: {
  items: Array<{ productId: string; qty: number }>;
  zoneId?: string;
  companyId?: string;
}): Promise<unknown> {
  const sb = supabaseAdmin();
  const companyId = args.companyId;
  const productIds = args.items.map(i => i.productId);
  let prodQuery = sb
    .from('products')
    .select('id, name, price, available')
    .in('id', productIds);
  if (companyId) prodQuery = prodQuery.eq('company_id', companyId);
  const { data: products, error: prodErr } = await prodQuery;
  if (prodErr) return { ok: false, error: prodErr.message };

  const productById = new Map((products ?? []).map(p => [p.id, p]));
  const unavailable: string[] = [];
  let subtotal = 0;
  const itemsResolved: Array<{ name: string; qty: number; subtotal: number }> = [];

  for (const it of args.items) {
    const p = productById.get(it.productId);
    if (!p) return { ok: false, error: `Producto no existe: ${it.productId}` };
    if (!p.available) {
      unavailable.push(p.name);
      continue;
    }
    const lineSub = p.price * it.qty;
    subtotal += lineSub;
    itemsResolved.push({ name: p.name, qty: it.qty, subtotal: lineSub });
  }
  if (unavailable.length > 0) {
    return { ok: false, error: 'No disponibles', unavailable };
  }

  // settings por empresa (con companyId) o fila única id=1 (legacy single-tenant).
  const settingsBase = sb.from('settings').select('base_delivery_fee');
  const { data: settings } = await (companyId
    ? settingsBase.eq('company_id', companyId)
    : settingsBase.eq('id', 1)
  ).maybeSingle();

  let zoneInfo: { id: string; name: string; tarifa: number } | null = null;
  if (args.zoneId) {
    let zoneQuery = sb.from('zones').select('id, name, tarifa').eq('id', args.zoneId);
    if (companyId) zoneQuery = zoneQuery.eq('company_id', companyId);
    const { data: z } = await zoneQuery.single();
    if (z) zoneInfo = z;
  }

  const baseDelivery = zoneInfo?.tarifa ?? settings?.base_delivery_fee ?? 4500;
  // Hora pico eliminada: sin recargo.
  const peakSurcharge = 0;
  const total = subtotal + baseDelivery + peakSurcharge;

  return {
    ok: true,
    items: itemsResolved,
    subtotal,
    delivery: baseDelivery,
    peakSurcharge,
    isPeakHour: false,
    total,
    zone: zoneInfo ? { id: zoneInfo.id, name: zoneInfo.name } : null,
  };
}

export async function crearPedido(args: {
  customerName: string;
  phone: string;
  address: string;
  zoneId: string;
  items: Array<{ productId: string; qty: number }>;
  paymentMethod: string;
  companyId?: string;
}): Promise<unknown> {
  // El bot crea el pedido DIRECTO en BD (multi-empresa). La vieja ruta global
  // `POST /api/orders` ya no existe; ver `lib/bot/orders.ts` para la decisión.
  if (!args.companyId) {
    return { ok: false, error: 'Falta companyId para crear el pedido.' };
  }
  return createBotOrder({
    companyId: args.companyId,
    customerName: args.customerName,
    phone: args.phone,
    address: args.address,
    zoneId: args.zoneId,
    items: args.items,
    paymentMethod: args.paymentMethod,
  });
}

export async function escalarAHumano(opts: {
  chatId: string;
  razon: string;
}): Promise<unknown> {
  const sb = supabaseAdmin();
  const { error } = await sb.from('chats').update({ status: 'human' }).eq('id', opts.chatId);
  if (error) return { ok: false, error: error.message };
  console.log('[bot] escalado a humano', { chatId: opts.chatId, razon: opts.razon });
  return { ok: true };
}

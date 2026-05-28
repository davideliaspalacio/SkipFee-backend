import { Type, type FunctionDeclaration } from '@google/genai';
import { supabaseAdmin } from '@/lib/db';
import { bogotaTime, isWithinRange } from '@/lib/pricing';

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
        note: { type: Type.STRING, description: 'Nota especial (opcional)' },
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

export async function consultarCarta(): Promise<unknown> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from('products')
    .select('id, name, price, cat')
    .eq('available', true)
    .order('cat')
    .order('name');
  if (error) return { ok: false, error: error.message };

  const byCategory = new Map<string, Array<{ id: string; name: string; price: number }>>();
  for (const p of data ?? []) {
    const list = byCategory.get(p.cat) ?? [];
    list.push({ id: p.id, name: p.name, price: p.price });
    byCategory.set(p.cat, list);
  }
  return {
    ok: true,
    categories: Array.from(byCategory.entries()).map(([cat, items]) => ({ cat, items })),
  };
}

export async function cotizarPedido(args: {
  items: Array<{ productId: string; qty: number }>;
  zoneId?: string;
}): Promise<unknown> {
  const sb = supabaseAdmin();
  const productIds = args.items.map(i => i.productId);
  const { data: products, error: prodErr } = await sb
    .from('products')
    .select('id, name, price, available')
    .in('id', productIds);
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

  const { data: settings } = await sb
    .from('settings')
    .select('peak_start, peak_end, peak_surcharge, base_delivery_fee')
    .eq('id', 1)
    .single();

  let zoneInfo: { id: string; name: string; tarifa: number; recargo: number } | null = null;
  if (args.zoneId) {
    const { data: z } = await sb
      .from('zones')
      .select('id, name, tarifa, recargo')
      .eq('id', args.zoneId)
      .single();
    if (z) zoneInfo = z;
  }

  const baseDelivery = zoneInfo?.tarifa ?? settings?.base_delivery_fee ?? 4500;
  const isPeak = isWithinRange(
    bogotaTime(),
    settings?.peak_start ?? null,
    settings?.peak_end ?? null,
  );
  const peakSurcharge = isPeak ? (zoneInfo?.recargo ?? settings?.peak_surcharge ?? 1500) : 0;
  const total = subtotal + baseDelivery + peakSurcharge;

  return {
    ok: true,
    items: itemsResolved,
    subtotal,
    delivery: baseDelivery,
    peakSurcharge,
    isPeakHour: isPeak,
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
  note?: string;
}): Promise<unknown> {
  // Reutilizamos el endpoint interno para no duplicar la lógica de validación.
  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'http://localhost:3000';
  const res = await fetch(`${origin}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: { name: args.customerName, phone: args.phone, addr: args.address },
      zoneId: args.zoneId,
      items: args.items,
      paymentMethod: args.paymentMethod,
      note: args.note,
    }),
  });
  const body = await res.json();
  return body;
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

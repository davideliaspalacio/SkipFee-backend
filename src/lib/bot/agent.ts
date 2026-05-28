import type { Content, FunctionCall } from '@google/genai';
import { gemini, geminiModel } from './gemini';
import { buildSystemPrompt } from './prompt';
import {
  toolDefinitions,
  consultarCarta,
  cotizarPedido,
  crearPedido,
  escalarAHumano,
} from './tools';
import { supabaseAdmin } from '@/lib/db';
import { sendText } from '@/lib/kapso/client';
import { recordMessage } from '@/lib/messaging';

const MAX_TOOL_LOOPS = 5;

/**
 * Procesa un mensaje entrante del cliente con el bot Gemini.
 *
 * Flujo:
 * 1. Carga el contexto del chat (historial reciente + datos del cliente + carrito).
 * 2. Construye el prompt + historial para Gemini.
 * 3. Bucle de tool-calling hasta que Gemini devuelva texto final.
 * 4. Envía la respuesta vía Kapso y persiste como direction='bot'.
 */
export async function botProcessMessage(opts: {
  chatId: string;
  phone: string;
  incomingBody: string;
}): Promise<void> {
  const sb = supabaseAdmin();

  // 1. Cargar contexto del cliente (si existe) y últimos mensajes del chat
  const [{ data: chat }, { data: history }] = await Promise.all([
    sb
      .from('chats')
      .select('name, phone, customer_id, customer:customers(name, addr, zone_id, tag, pedidos)')
      .eq('id', opts.chatId)
      .single(),
    sb
      .from('messages')
      .select('direction, body, created_at')
      .eq('chat_id', opts.chatId)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  const customerRow = Array.isArray(chat?.customer) ? chat?.customer[0] : chat?.customer;
  const systemPrompt = buildSystemPrompt({
    customer: customerRow
      ? {
          name: customerRow.name,
          isReturning: (customerRow.pedidos ?? 0) > 0,
          tag: customerRow.tag as 'VIP' | 'Recurrente' | 'Nuevo' | null,
          lastAddress: customerRow.addr,
          lastZone: customerRow.zone_id,
          prevOrders: customerRow.pedidos,
        }
      : { name: chat?.name },
  });

  // Construye historial Gemini (orden cronológico ascendente)
  const historyContents: Content[] = (history ?? [])
    .reverse()
    .filter(m => m.body && m.body.length > 0)
    .map(m => ({
      role: m.direction === 'in' ? 'user' : 'model',
      parts: [{ text: m.body }],
    }));

  // El último mensaje (el actual) ya está en historyContents si fue persistido antes.
  // Si no, lo agregamos como user.
  const lastMessage = historyContents[historyContents.length - 1];
  if (!lastMessage || lastMessage.role !== 'user' || lastMessage.parts?.[0]?.text !== opts.incomingBody) {
    historyContents.push({ role: 'user', parts: [{ text: opts.incomingBody }] });
  }

  // 2. Bucle de tool calling
  const client = gemini();
  const contents: Content[] = [...historyContents];
  let finalText: string | null = null;
  let escalated = false;

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const response = await client.models.generateContent({
      model: geminiModel(),
      contents,
      config: {
        systemInstruction: systemPrompt,
        tools: [{ functionDeclarations: toolDefinitions }],
        temperature: 0.7,
      },
    });

    const functionCalls = response.functionCalls;
    const text = response.text;

    if (functionCalls && functionCalls.length > 0) {
      // Ejecutar tools y agregar resultados al historial para el siguiente turno
      const modelTurn: Content = {
        role: 'model',
        parts: functionCalls.map(fc => ({ functionCall: fc })),
      };
      contents.push(modelTurn);

      const toolTurn: Content = { role: 'user', parts: [] };
      for (const call of functionCalls) {
        const result = await executeTool(call, opts.chatId);
        toolTurn.parts!.push({
          functionResponse: {
            name: call.name!,
            response: { result: result as Record<string, unknown> },
          },
        });
        if (call.name === 'escalarAHumano') escalated = true;
      }
      contents.push(toolTurn);
      continue; // siguiente loop
    }

    if (text) {
      finalText = text;
      break;
    }

    // Sin tool ni texto — abortar
    console.warn('[bot] respuesta sin texto ni tool calls', response);
    break;
  }

  // 3. Si escaló, no mandamos respuesta del bot (el humano va a tomar)
  if (escalated && !finalText) {
    finalText =
      'Para esto te paso con uno de mis compas humanos, ya te responden en un momentico 🙏';
  }

  // 4. Enviar respuesta vía Kapso y persistir
  if (finalText) {
    try {
      const result = await sendText(opts.phone, finalText);
      const wamid = result.messages?.[0]?.id ?? null;
      await recordMessage({
        phone: opts.phone,
        direction: 'bot',
        body: finalText,
        kapsoMessageId: wamid,
      });
    } catch (err) {
      console.error('[bot] error enviando respuesta', err);
    }
  }
}

async function executeTool(call: FunctionCall, chatId: string): Promise<unknown> {
  const args = (call.args ?? {}) as Record<string, unknown>;
  try {
    switch (call.name) {
      case 'consultarCarta':
        return await consultarCarta();
      case 'cotizarPedido':
        return await cotizarPedido(args as Parameters<typeof cotizarPedido>[0]);
      case 'crearPedido':
        return await crearPedido(args as Parameters<typeof crearPedido>[0]);
      case 'escalarAHumano':
        return await escalarAHumano({ chatId, razon: (args.razon as string) ?? '' });
      default:
        return { ok: false, error: `Tool desconocido: ${call.name}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[bot] tool error', { name: call.name, err });
    return { ok: false, error: message };
  }
}

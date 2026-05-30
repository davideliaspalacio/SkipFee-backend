import { Type } from '@google/genai';
import { gemini, geminiModel } from '@/lib/bot/gemini';

/**
 * Fallback con Gemini para cuando el cliente escribe texto libre que no
 * matchea ningún botón / list reply esperado en el step actual.
 *
 * Lo invocan handlers seleccionados (handleAlgoMas, handleResumen, etc.)
 * en lugar de simplemente ignorar el texto o reenviar el prompt textual.
 *
 * Gemini decide entre 3 acciones:
 * - 'continue' → mandamos `reply` al cliente como respuesta clarificadora
 *                y reenviamos el prompt original del step (que el caller
 *                ya tiene)
 * - 'cancel'   → el cliente quiere cancelar el flujo (sin haber usado la
 *                palabra clave global)
 * - 'human'    → el cliente quiere escalar a humano
 *
 * El modelo (gemini-2.5-flash por default) es barato y suficiente para
 * esto. Temperature baja para respuestas predecibles.
 */

export type FallbackIntent = 'continue' | 'cancel' | 'human';

export interface FallbackResult {
  intent: FallbackIntent;
  reply: string;
}

const FALLBACK_TIMEOUT_MS = 6_000;

const SYSTEM_PROMPT = `Sos el asistente del bot de Bros and Subs (sandwichería en Medellín).
Tu trabajo es interpretar un mensaje del cliente cuando se sale del flujo guiado
de botones y darle una respuesta corta en español paisa (vos forma, 1-2 oraciones,
sin emojis excesivos) para reorientarlo al paso actual del pedido.

Reglas:
- Si el cliente quiere cancelar el pedido → intent="cancel", reply con despedida cordial.
- Si el cliente pide hablar con humano o tiene un problema que no podés resolver
  con un mensaje guía → intent="human", reply diciendo que lo pasás con un humano.
- Si es una pregunta común que podés responder (ej. "¿tienen sin gluten?",
  "¿cuánto tarda?", "¿aceptan tarjeta?") → intent="continue", responde brevemente
  y recuerdá al cliente que use los botones del último mensaje del bot para seguir.
- Si no entendés qué quiere → intent="continue", reply pidiendo que use los botones
  del último mensaje.

NUNCA inventes precios, productos, horarios o tiempos de entrega — si te preguntan
algo específico que no sabés, escala a humano.

Devolvé siempre el JSON estructurado (no texto suelto).`;

const responseSchema = {
  type: Type.OBJECT,
  required: ['intent', 'reply'],
  properties: {
    intent: { type: Type.STRING, enum: ['continue', 'cancel', 'human'] },
    reply: { type: Type.STRING, description: 'Respuesta corta (1-2 oraciones) en español paisa.' },
  },
};

/**
 * Resultado por defecto si Gemini falla, timeoutea o devuelve algo inválido.
 * Es seguro: trata como "continue" con reenvío del prompt, sin cancelar nada.
 */
const SAFE_DEFAULT: FallbackResult = {
  intent: 'continue',
  reply: 'No entendí bien parce, ¿podés usar los botones del mensaje anterior?',
};

export async function assistOffScript(opts: {
  /** Descripción corta del paso actual del flujo, ej. "carrito armado, esperando confirmar pago" */
  stepDescription: string;
  /** Lo último que pidió el bot al cliente, ej. "¿Confirmás el pedido?" */
  lastBotPrompt: string;
  /** Texto literal que escribió el cliente */
  userText: string;
}): Promise<FallbackResult> {
  const userMessage = `Paso actual: ${opts.stepDescription}
Último mensaje del bot al cliente: "${opts.lastBotPrompt}"

Mensaje del cliente: "${opts.userText}"

Devolvé el JSON con tu interpretación.`;

  try {
    const client = gemini();
    const response = await Promise.race([
      client.models.generateContent({
        model: geminiModel(),
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.3,
          responseMimeType: 'application/json',
          responseSchema,
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('gemini-fallback timeout')), FALLBACK_TIMEOUT_MS),
      ),
    ]);

    const text = response.text;
    if (!text) return SAFE_DEFAULT;

    const parsed = JSON.parse(text) as Partial<FallbackResult>;
    if (
      !parsed.intent ||
      !['continue', 'cancel', 'human'].includes(parsed.intent) ||
      !parsed.reply
    ) {
      return SAFE_DEFAULT;
    }
    return { intent: parsed.intent as FallbackIntent, reply: parsed.reply };
  } catch (err) {
    console.warn('[gemini-fallback] error, usando default', err);
    return SAFE_DEFAULT;
  }
}

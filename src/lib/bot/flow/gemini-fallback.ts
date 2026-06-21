import { Type } from '@google/genai';
import { gemini, geminiModel } from '@/lib/bot/gemini';
import { getMessage } from '@/lib/bot/messages/catalog';

/**
 * Fallback con Gemini para cuando el cliente escribe texto libre que no
 * matchea ningún botón / list reply esperado en el step actual.
 *
 * El tono/persona (system prompt) y la respuesta por defecto son EDITABLES
 * desde la UI: se resuelven del catálogo (`ia.fallback`). Con la tabla vacía
 * caen a los defaults del código.
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

const responseSchema = {
  type: Type.OBJECT,
  required: ['intent', 'reply'],
  properties: {
    intent: { type: Type.STRING, enum: ['continue', 'cancel', 'human'] },
    reply: { type: Type.STRING, description: 'Respuesta corta (1-2 oraciones) en español paisa.' },
  },
};

export async function assistOffScript(opts: {
  /** Descripción corta del paso actual del flujo, ej. "carrito armado, esperando confirmar pago" */
  stepDescription: string;
  /** Lo último que pidió el bot al cliente, ej. "¿Confirmás el pedido?" */
  lastBotPrompt: string;
  /** Texto literal que escribió el cliente */
  userText: string;
  /** Empresa dueña del chat: el tono/persona (`ia.fallback`) es editable por empresa. */
  companyId?: string;
}): Promise<FallbackResult> {
  // Tono/persona + respuesta segura editables desde la UI (por empresa).
  const cfg = await getMessage('ia.fallback', opts.companyId);
  const systemPrompt = cfg.systemPrompt ?? '';
  /**
   * Resultado por defecto si Gemini falla, timeoutea o devuelve algo inválido.
   * Es seguro: trata como "continue" con reenvío del prompt, sin cancelar nada.
   */
  const safeDefault: FallbackResult = {
    intent: 'continue',
    reply: cfg.safeDefault ?? 'No entendí bien parce, ¿podés usar los botones del mensaje anterior?',
  };

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
          systemInstruction: systemPrompt,
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
    if (!text) return safeDefault;

    const parsed = JSON.parse(text) as Partial<FallbackResult>;
    if (
      !parsed.intent ||
      !['continue', 'cancel', 'human'].includes(parsed.intent) ||
      !parsed.reply
    ) {
      return safeDefault;
    }
    return { intent: parsed.intent as FallbackIntent, reply: parsed.reply };
  } catch (err) {
    console.warn('[gemini-fallback] error, usando default', err);
    return safeDefault;
  }
}

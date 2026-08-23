/**
 * Extracción de la carta desde una foto o un PDF.
 *
 * Es el paso más pesado del onboarding y el que más abandono genera: meter 40
 * u 80 productos a mano antes de poder vender. Ningún competidor lo resuelve
 * sin topes — Fudo se rinde a los 40 productos, Siigo permite 200 pero solo en
 * su plan más caro, y Loggro lo hace por ti cobrando $488.990. Ahí está el
 * hueco.
 *
 * Usa Gemini con salida estructurada, que ya está integrado para el fallback
 * del bot: cero infraestructura nueva y céntimos por carta.
 *
 * DOS DECISIONES DELIBERADAS
 *
 * 1. **No se extraen modificadores ni opciones.** Es el campo con peor
 *    precisión reportada (~85%) y el que más complica el resultado. Producto
 *    plano; los pocos ítems que necesiten opciones se ajustan a mano después.
 *
 * 2. **El precio se valida contra un rango plausible en COP.** La precisión de
 *    extracción de precios ronda el 97%: en una carta de 60 ítems son ~2 mal
 *    leídos, y un precio equivocado es plata perdida o un cliente furioso. Todo
 *    lo dudoso sale marcado para que el dueño lo revise, no publicado en
 *    silencio.
 *
 * Esto NUNCA publica solo. Devuelve un borrador para revisar.
 */

import { Type } from '@google/genai';
import { gemini, geminiModel } from '@/lib/bot/gemini';

/** Rango plausible de un producto de restaurante en COP. Fuera de aquí, se marca. */
export const PRECIO_MIN_COP = 1_000;
export const PRECIO_MAX_COP = 500_000;

const TIMEOUT_MS = 90_000;
export const MAX_BYTES = 12 * 1024 * 1024; // 12 MB
export const TIPOS_ACEPTADOS = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export interface ProductoExtraido {
  nombre: string;
  descripcion: string | null;
  /** Entero en COP. `null` si no se pudo leer un precio confiable. */
  precio: number | null;
  categoria: string;
  /** 0–1, lo que el modelo cree de su propia lectura. */
  confianza: number;
  /** Motivos por los que este ítem necesita revisión humana. Vacío = limpio. */
  avisos: string[];
}

export interface CartaExtraida {
  categorias: string[];
  productos: ProductoExtraido[];
  /** Cuántos ítems necesitan que el dueño los mire. */
  necesitanRevision: number;
}

const schema = {
  type: Type.OBJECT,
  required: ['productos'],
  properties: {
    productos: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ['nombre', 'categoria', 'confianza'],
        properties: {
          nombre: { type: Type.STRING, description: 'Nombre del plato, tal cual aparece.' },
          descripcion: {
            type: Type.STRING,
            description: 'Descripción o ingredientes si la carta los trae. Vacío si no.',
          },
          precio: {
            type: Type.NUMBER,
            description:
              'Precio en pesos colombianos, SIN puntos ni símbolos. "12.500" son 12500. ' +
              'Si la carta muestra el precio en miles ("12.5"), conviértelo a 12500. ' +
              'Si no hay precio legible, omite este campo.',
          },
          categoria: {
            type: Type.STRING,
            description: 'La sección de la carta donde está (Entradas, Bebidas, etc.).',
          },
          confianza: {
            type: Type.NUMBER,
            description: 'De 0 a 1, qué tan seguro estás de haber leído bien este ítem.',
          },
        },
      },
    },
  },
};

const INSTRUCCION = `Eres un asistente que digitaliza cartas de restaurantes colombianos.

Te dan la foto o el PDF de una carta. Devuelve TODOS los productos que veas, con su categoría.

Reglas:
- Los precios están en pesos colombianos. Devuélvelos como número entero, sin puntos ni "$".
  "12.500" → 12500. "$ 8.000" → 8000. Si la carta usa miles abreviados ("12.5"), son 12500.
- Si un precio no se lee con claridad, OMITE el campo precio. Es mejor dejarlo vacío que inventarlo.
- NO inventes productos que no estén en la imagen. NO completes una carta que se ve incompleta.
- NO extraigas opciones, tamaños ni adiciones como productos aparte: solo el producto base.
  Si un plato tiene dos tamaños con precios distintos, usa el menor y bájale la confianza.
- La categoría sale de las secciones de la carta. Si no hay secciones, usa "Carta".
- La confianza refleja qué tan legible estaba: texto nítido 0.95, manuscrito o borroso 0.5.

Responde solo con el JSON.`;

/**
 * Convierte lo que devolvió el modelo en algo publicable, marcando lo dudoso.
 *
 * Acá vive la desconfianza: el modelo casi siempre devuelve JSON válido, pero
 * los VALORES —sobre todo los números— fallan más de lo que su fluidez sugiere.
 */
/**
 * "ENTRADAS" → "Entradas". Las cartas suelen escribir las secciones en
 * mayúsculas por diseño impreso, pero en la tienda eso se lee como gritos.
 */
function normalizarCategoria(raw: string): string {
  const t = raw.trim();
  if (!t) return 'Carta';
  // Si ya viene en mayúsculas y minúsculas mezcladas, se respeta tal cual.
  if (t !== t.toUpperCase()) return t;
  return t
    .toLocaleLowerCase('es-CO')
    .split(/\s+/)
    .map(w => (w.length > 2 ? w[0].toLocaleUpperCase('es-CO') + w.slice(1) : w))
    .join(' ');
}

function revisar(crudo: unknown): CartaExtraida {
  const items = Array.isArray((crudo as { productos?: unknown })?.productos)
    ? ((crudo as { productos: unknown[] }).productos)
    : [];

  const productos: ProductoExtraido[] = [];
  const categorias = new Set<string>();

  for (const it of items) {
    const o = it as Record<string, unknown>;
    const nombre = typeof o.nombre === 'string' ? o.nombre.trim() : '';
    if (!nombre) continue; // sin nombre no hay producto

    const categoria = normalizarCategoria(typeof o.categoria === 'string' ? o.categoria : '');
    const confianza = typeof o.confianza === 'number' ? Math.max(0, Math.min(1, o.confianza)) : 0.5;

    const avisos: string[] = [];
    let precio: number | null = null;

    if (typeof o.precio === 'number' && Number.isFinite(o.precio)) {
      const redondeado = Math.round(o.precio);
      if (redondeado < PRECIO_MIN_COP || redondeado > PRECIO_MAX_COP) {
        // Se conserva el valor para que el dueño lo vea y corrija, pero marcado.
        precio = redondeado;
        avisos.push('El precio se ve raro, confírmalo');
      } else {
        precio = redondeado;
      }
    } else {
      avisos.push('No pudimos leer el precio');
    }

    if (confianza < 0.75) avisos.push('El texto no se leía bien');

    categorias.add(categoria);
    productos.push({
      nombre,
      descripcion: typeof o.descripcion === 'string' && o.descripcion.trim() ? o.descripcion.trim() : null,
      precio,
      categoria,
      confianza,
      avisos,
    });
  }

  return {
    categorias: [...categorias],
    productos,
    necesitanRevision: productos.filter(p => p.avisos.length > 0).length,
  };
}

/**
 * Traduce los fallos de Gemini a algo que un dueño de restaurante entienda.
 * Sin esto el panel mostraba el JSON crudo de Google, que no le dice nada a
 * nadie y encima expone detalles del proveedor.
 */
function mensajeDeError(err: unknown): string {
  const texto = err instanceof Error ? err.message : String(err);
  if (texto.includes('tardó demasiado')) {
    return 'La carta tardó demasiado en procesarse. Si tiene muchas páginas, prueba subiéndolas de a una.';
  }
  if (/503|UNAVAILABLE|high demand|overloaded/i.test(texto)) {
    return 'El servicio de lectura está congestionado. Espera un momento y vuelve a intentarlo.';
  }
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(texto)) {
    return 'Alcanzamos el límite de lecturas por ahora. Intenta en unos minutos.';
  }
  if (/400|INVALID_ARGUMENT/i.test(texto)) {
    return 'No pudimos procesar ese archivo. Prueba con una foto en JPG o PNG.';
  }
  return 'No pudimos leer la carta. Revisa que la foto se vea completa y con buena luz.';
}

export async function extraerCarta(opts: {
  base64: string;
  mimeType: string;
}): Promise<CartaExtraida> {
  try {
    return await extraerCartaInterno(opts);
  } catch (err) {
    console.error('[catalog/extract] fallo del modelo', err);
    throw new Error(mensajeDeError(err));
  }
}

async function extraerCartaInterno(opts: {
  base64: string;
  mimeType: string;
}): Promise<CartaExtraida> {
  const respuesta = await Promise.race([
    gemini().models.generateContent({
      model: geminiModel(),
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: opts.mimeType, data: opts.base64 } },
            { text: 'Digitaliza esta carta.' },
          ],
        },
      ],
      config: {
        systemInstruction: INSTRUCCION,
        // Temperatura baja: acá no queremos creatividad, queremos transcripción.
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('La lectura de la carta tardó demasiado')), TIMEOUT_MS),
    ),
  ]);

  const texto = respuesta.text;
  if (!texto) throw new Error('El modelo no devolvió nada');

  let crudo: unknown;
  try {
    crudo = JSON.parse(texto);
  } catch {
    throw new Error('No pudimos interpretar la carta');
  }

  return revisar(crudo);
}

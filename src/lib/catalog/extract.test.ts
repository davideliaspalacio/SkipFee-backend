import { beforeEach, describe, expect, it, vi } from 'vitest';

let respuestaDelModelo: unknown = {};
/** Si se setea, `generateContent` lanza este error en vez de responder. */
let errorDelModelo: Error | null = null;

vi.mock('@/lib/bot/gemini', () => ({
  gemini: () => ({
    models: {
      generateContent: async () => {
        if (errorDelModelo) throw errorDelModelo;
        return { text: JSON.stringify(respuestaDelModelo) };
      },
    },
  }),
  geminiModel: () => 'gemini-2.5-flash',
}));

import { extraerCarta, PRECIO_MAX_COP, PRECIO_MIN_COP } from './extract';

beforeEach(() => {
  respuestaDelModelo = {};
  errorDelModelo = null;
});

/**
 * Lo que se prueba aquí no es que Gemini lea bien —eso no lo controlamos— sino
 * que NADA dudoso pase a producción sin marcar. El modelo casi siempre devuelve
 * JSON válido; son los VALORES los que fallan.
 */
describe('extraerCarta', () => {
  it('convierte una carta limpia sin marcar nada', async () => {
    respuestaDelModelo = {
      productos: [
        { nombre: 'Pizza Margarita', descripcion: 'Tomate y albahaca', precio: 32000, categoria: 'Pizzas', confianza: 0.96 },
        { nombre: 'Limonada', precio: 8000, categoria: 'Bebidas', confianza: 0.95 },
      ],
    };
    const r = await extraerCarta({ base64: 'x', mimeType: 'image/jpeg' });
    expect(r.productos).toHaveLength(2);
    expect(r.necesitanRevision).toBe(0);
    expect(r.categorias.sort()).toEqual(['Bebidas', 'Pizzas']);
    expect(r.productos[0].precio).toBe(32000);
  });

  it('marca el precio fuera de rango PERO lo conserva para que el dueño lo corrija', async () => {
    respuestaDelModelo = {
      productos: [
        { nombre: 'Pizza', precio: 32, categoria: 'Pizzas', confianza: 0.95 },        // leyó "32" en vez de 32000
        { nombre: 'Vino', precio: 9_000_000, categoria: 'Bebidas', confianza: 0.9 },  // absurdo
      ],
    };
    const r = await extraerCarta({ base64: 'x', mimeType: 'image/jpeg' });
    expect(r.necesitanRevision).toBe(2);
    for (const p of r.productos) {
      expect(p.avisos).toContain('El precio se ve raro, confírmalo');
      expect(p.precio).not.toBeNull(); // se conserva: el dueño lo corrige, no lo reescribe
    }
  });

  it('marca el producto sin precio legible', async () => {
    respuestaDelModelo = { productos: [{ nombre: 'Plato del día', categoria: 'Carta', confianza: 0.9 }] };
    const r = await extraerCarta({ base64: 'x', mimeType: 'image/jpeg' });
    expect(r.productos[0].precio).toBeNull();
    expect(r.productos[0].avisos).toContain('No pudimos leer el precio');
  });

  it('marca lo que el modelo leyó con poca confianza', async () => {
    respuestaDelModelo = {
      productos: [{ nombre: 'Algo borroso', precio: 15000, categoria: 'Carta', confianza: 0.4 }],
    };
    const r = await extraerCarta({ base64: 'x', mimeType: 'image/jpeg' });
    expect(r.productos[0].avisos).toContain('El texto no se leía bien');
  });

  it('descarta productos sin nombre en vez de crear basura', async () => {
    respuestaDelModelo = {
      productos: [
        { nombre: '', precio: 10000, categoria: 'X', confianza: 0.9 },
        { nombre: '   ', precio: 10000, categoria: 'X', confianza: 0.9 },
        { nombre: 'Real', precio: 10000, categoria: 'X', confianza: 0.9 },
      ],
    };
    const r = await extraerCarta({ base64: 'x', mimeType: 'image/jpeg' });
    expect(r.productos).toHaveLength(1);
    expect(r.productos[0].nombre).toBe('Real');
  });

  it('cae a la categoría "Carta" cuando la carta no tiene secciones', async () => {
    respuestaDelModelo = { productos: [{ nombre: 'X', precio: 10000, categoria: '', confianza: 0.9 }] };
    const r = await extraerCarta({ base64: 'x', mimeType: 'image/jpeg' });
    expect(r.productos[0].categoria).toBe('Carta');
  });

  it('acepta los bordes exactos del rango de precio sin marcarlos', async () => {
    respuestaDelModelo = {
      productos: [
        { nombre: 'Barato', precio: PRECIO_MIN_COP, categoria: 'X', confianza: 0.95 },
        { nombre: 'Caro', precio: PRECIO_MAX_COP, categoria: 'X', confianza: 0.95 },
      ],
    };
    const r = await extraerCarta({ base64: 'x', mimeType: 'image/jpeg' });
    expect(r.necesitanRevision).toBe(0);
  });

  it('no revienta si el modelo devuelve algo inesperado', async () => {
    respuestaDelModelo = { otraCosa: true };
    const r = await extraerCarta({ base64: 'x', mimeType: 'image/jpeg' });
    expect(r.productos).toEqual([]);
    expect(r.necesitanRevision).toBe(0);
  });

  it('normaliza las categorías en mayúsculas: "ENTRADAS" no debe gritar en la tienda', async () => {
    respuestaDelModelo = {
      productos: [
        { nombre: 'A', precio: 10000, categoria: 'ENTRADAS', confianza: 0.95 },
        { nombre: 'B', precio: 10000, categoria: 'PARA COMPARTIR', confianza: 0.95 },
        { nombre: 'C', precio: 10000, categoria: 'Postres', confianza: 0.95 },
      ],
    };
    const r = await extraerCarta({ base64: 'x', mimeType: 'image/jpeg' });
    expect(r.productos.map(p => p.categoria)).toEqual(['Entradas', 'Para Compartir', 'Postres']);
  });

  it('traduce los fallos del modelo a algo que un dueño entienda', async () => {
    // El panel mostraba el JSON crudo de Google, que no le dice nada a nadie.
    errorDelModelo = new Error('{"error":{"code":503,"message":"high demand","status":"UNAVAILABLE"}}');
    await expect(extraerCarta({ base64: 'x', mimeType: 'image/jpeg' })).rejects.toThrow(/congestionado/i);

    errorDelModelo = new Error('La lectura de la carta tardó demasiado');
    await expect(extraerCarta({ base64: 'x', mimeType: 'image/jpeg' })).rejects.toThrow(/muchas páginas/i);

    errorDelModelo = new Error('429 RESOURCE_EXHAUSTED');
    await expect(extraerCarta({ base64: 'x', mimeType: 'image/jpeg' })).rejects.toThrow(/límite de lecturas/i);
  });

  it('redondea precios decimales', async () => {
    respuestaDelModelo = { productos: [{ nombre: 'X', precio: 12499.7, categoria: 'X', confianza: 0.95 }] };
    const r = await extraerCarta({ base64: 'x', mimeType: 'image/jpeg' });
    expect(r.productos[0].precio).toBe(12500);
  });
});

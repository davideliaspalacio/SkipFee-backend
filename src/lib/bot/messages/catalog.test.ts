import { describe, it, expect, vi, beforeEach } from 'vitest';

let overridesData: unknown[] = [];
let shouldThrow = false;

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => {
    if (shouldThrow) throw new Error('sin env');
    return {
      from: () => ({
        select: () => Promise.resolve({ data: overridesData, error: null }),
      }),
    };
  },
}));

import { getMessage, getAllMessages, getKeywords, invalidateCatalog } from './catalog';
import { MESSAGE_DEFS_LIST } from './defaults';
import { render } from './render';

beforeEach(() => {
  overridesData = [];
  shouldThrow = false;
  invalidateCatalog();
});

describe('catalog — sin overrides', () => {
  it('devuelve el texto por defecto', async () => {
    const m = await getMessage('registro.gracias');
    expect(m.body).toBe('¡Gracias!');
    expect(m.isCustomized).toBe(false);
    expect(m.enabled).toBe(true);
  });

  it('getAllMessages cubre todo el catálogo', async () => {
    const all = await getAllMessages();
    expect(all).toHaveLength(MESSAGE_DEFS_LIST.length);
  });

  it('keywords por defecto', async () => {
    const kw = await getKeywords('keywords.cancelar');
    expect(kw).toContain('cancelar');
    expect(kw).toContain('salir');
  });
});

describe('catalog — con overrides', () => {
  it('mergea el body editado y marca isCustomized', async () => {
    overridesData = [{ key: 'registro.gracias', content: { body: '¡Mil gracias!' }, enabled: true }];
    invalidateCatalog();
    const m = await getMessage('registro.gracias');
    expect(m.body).toBe('¡Mil gracias!');
    expect(m.isCustomized).toBe(true);
  });

  it('reemplaza los botones por los editados', async () => {
    overridesData = [{
      key: 'menu.pedir',
      content: { body: '¿Pedimos?', buttons: [{ id: 'menu_pedir', title: 'Pedir ya' }] },
      enabled: true,
    }];
    invalidateCatalog();
    const m = await getMessage('menu.pedir');
    expect(m.body).toBe('¿Pedimos?');
    expect(m.buttons).toEqual([{ id: 'menu_pedir', title: 'Pedir ya' }]);
  });

  it('respeta enabled=false', async () => {
    overridesData = [{ key: 'nudge.menu', content: { body: 'x' }, enabled: false }];
    invalidateCatalog();
    const m = await getMessage('nudge.menu');
    expect(m.enabled).toBe(false);
  });
});

describe('catalog — robustez', () => {
  it('si la BD lanza, cae a defaults (no rompe)', async () => {
    shouldThrow = true;
    invalidateCatalog();
    const m = await getMessage('link.error');
    expect(m.body).toContain('no pude generar');
  });

  it('key desconocida → texto vacío seguro', async () => {
    const m = await getMessage('no.existe');
    expect(m.body).toBe('');
  });
});

describe('catalog — regresión de textos críticos', () => {
  it('mantiene los strings por defecto exactos', async () => {
    expect((await getMessage('saludo.nuevo')).body).toBe('¡Quihubo {{nombre}}! Soy el bot de pedidos.\n¿Hacemos un pedido?');
    expect((await getMessage('registro.gracias')).body).toBe('¡Gracias!');
    expect((await getMessage('ia.fallback')).safeDefault).toContain('No entendí');
    expect((await getMessage('keywords.pedir')).words).toContain('quiero hacer un pedido');
  });

  it('saludo a cliente nuevo: con y sin nombre', async () => {
    const m = await getMessage('saludo.nuevo');
    expect(render(m.body, { nombre: 'Juan' })).toBe('¡Quihubo Juan! Soy el bot de pedidos.\n¿Hacemos un pedido?');
    expect(render(m.body, { nombre: 'parce' })).toBe('¡Quihubo parce! Soy el bot de pedidos.\n¿Hacemos un pedido?');
  });

  it('notificaciones: saludo "Hola {nombre}" o "Hola"', async () => {
    expect(render((await getMessage('notif.pagado')).body, { saludo: 'Hola Ana', nombre: 'Ana' }))
      .toBe('Hola Ana, ¡pago recibido! 🎉 Tu pedido ya pasa a cocina 🥪 Te aviso cuando vaya en camino.');
    expect(render((await getMessage('notif.ruta')).body, { saludo: 'Hola', nombre: '' }))
      .toBe('Hola, tu pedido va en camino 🛵');
    expect(render((await getMessage('notif.entregado')).body, { saludo: 'Hola Ana', nombre: 'Ana' }))
      .toBe('Hola Ana, ¡tu pedido fue entregado! 🙌 Gracias por tu compra.');
  });

  it('confirmar dirección renderiza con variables (3 botones: guardar/cambiar/no guardar)', async () => {
    const m = await getMessage('direccion.confirmar');
    expect(render(m.body, { direccion: 'Cra 43A', zona: 'El Poblado', tarifa: '4.500' }))
      .toBe('¿La dirección es correcta y deseas guardarla para futuros pedidos? 👇\n\n📍 Cra 43A\n🗺️ El Poblado · domicilio $4.500');
    expect(m.buttons).toEqual([
      { id: 'dir_si_guardar', title: '✅ Sí y guardar' },
      { id: 'dir_editar', title: '✏️ Cambiar dirección' },
      { id: 'dir_si_no_guardar', title: '❗ Sí pero no guardar' },
    ]);
  });

  it('link de tienda: body + displayText', async () => {
    const m = await getMessage('link.enviar');
    expect(m.displayText).toBe('Ver carta y pedir 🛒');
    expect(m.body).toContain('Armá tu pedido en nuestra tienda');
  });
});

describe('catálogo — límites de WhatsApp en los defaults', () => {
  // WhatsApp/Kapso rechaza títulos de botón > 20 chars (los emojis subrogados
  // cuentan como 2). Este test evita que un default rompa el envío en runtime.
  const BTN_MAX = 20;
  it('todo título de botón, botón de lista y CTA respeta ≤20 caracteres', () => {
    const offenders: string[] = [];
    for (const def of MESSAGE_DEFS_LIST) {
      for (const b of def.default.buttons ?? []) {
        if (b.title.length > BTN_MAX) offenders.push(`${def.key} botón "${b.title}" (${b.title.length})`);
      }
      if (def.default.buttonText && def.default.buttonText.length > BTN_MAX) {
        offenders.push(`${def.key} buttonText "${def.default.buttonText}" (${def.default.buttonText.length})`);
      }
      if (def.default.displayText && def.default.displayText.length > BTN_MAX) {
        offenders.push(`${def.key} displayText "${def.default.displayText}" (${def.default.displayText.length})`);
      }
    }
    expect(offenders, offenders.join(' · ')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './prompt';

/**
 * El prompt estaba cableado al negocio piloto. Estos tests fijan que ninguna
 * empresa vuelva a heredar esa identidad, y que cuando falta un dato el prompt
 * calle en vez de inventar.
 */
describe('buildSystemPrompt', () => {
  it('usa el nombre y la descripción reales de la empresa', () => {
    const p = buildSystemPrompt({
      business: { name: 'Pizzería Napoli', description: 'pizzería napolitana en Laureles' },
    });
    expect(p).toContain('Sos el bot de **Pizzería Napoli**, pizzería napolitana en Laureles.');
  });

  it('NUNCA menciona al negocio piloto', () => {
    const p = buildSystemPrompt({ business: { name: 'Farmacia del Centro' } });
    for (const rastro of ['Bros and Subs', 'Pastrami', 'sandwichería']) {
      expect(p).not.toContain(rastro);
    }
  });

  it('lista las zonas reales de la empresa', () => {
    const p = buildSystemPrompt({
      business: { name: 'X', zoneNames: ['Laureles', 'Belén'] },
    });
    expect(p).toContain('Laureles, Belén');
    // Y no las del piloto
    expect(p).not.toContain('Envigado');
  });

  it('sin zonas cargadas prohíbe prometer entrega', () => {
    const p = buildSystemPrompt({ business: { name: 'X' } });
    expect(p).toContain('Todavía no hay zonas de cobertura cargadas');
    expect(p).toContain('NO prometas entrega');
  });

  it('omite el bloque de horarios si no están configurados', () => {
    const sin = buildSystemPrompt({ business: { name: 'X' } });
    expect(sin).not.toContain('HORARIOS:');

    const con = buildSystemPrompt({
      business: { name: 'X', openHour: '08:00', closeHour: '20:00' },
    });
    expect(con).toContain('atiende de 08:00 a 20:00');
  });

  it('se degrada a genérico sin contexto de negocio', () => {
    const p = buildSystemPrompt({});
    expect(p).toContain('Sos el bot de **el negocio**.');
    expect(p).not.toContain('undefined');
    expect(p).not.toContain('null');
  });

  it('prohíbe inventar datos del negocio', () => {
    const p = buildSystemPrompt({ business: { name: 'X' } });
    expect(p).toContain('NUNCA inventes datos del negocio');
  });

  it('conserva el contexto del cliente recurrente', () => {
    const p = buildSystemPrompt({
      business: { name: 'X' },
      customer: {
        name: 'Ana',
        isReturning: true,
        prevOrders: 3,
        tag: 'VIP',
        lastAddress: 'Cra 43A #5-15',
        lastZone: 'poblado',
      },
    });
    expect(p).toContain('El cliente se llama Ana.');
    expect(p).toContain('Ya ha hecho 3 pedidos');
    expect(p).toContain('cliente VIP');
    expect(p).toContain('Cra 43A #5-15');
  });
});

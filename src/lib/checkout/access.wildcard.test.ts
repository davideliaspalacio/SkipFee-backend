import { afterEach, describe, expect, it } from 'vitest';
import { esSubdominioDeTienda, isAllowedOrigin, isPublicPath } from './access';

const original = process.env.STOREFRONT_WILDCARD_ROOTS;
afterEach(() => {
  if (original === undefined) delete process.env.STOREFRONT_WILDCARD_ROOTS;
  else process.env.STOREFRONT_WILDCARD_ROOTS = original;
});

describe('dominios de negocio', () => {
  it('acepta el subdominio de un restaurante', () => {
    expect(esSubdominioDeTienda('https://arepas.skipfee.co')).toBe(true);
    expect(isAllowedOrigin('https://arepas.skipfee.co')).toBe(true);
  });

  it('rechaza http, para que nadie suplante por el canal sin cifrar', () => {
    expect(esSubdominioDeTienda('http://arepas.skipfee.co')).toBe(false);
  });

  it('rechaza un dominio que solo TERMINA en la raíz', () => {
    // El fallo clásico de comparar sufijos sin el punto: alguien registra
    // `noskipfee.co` y se cuela con permisos de la casa.
    expect(esSubdominioDeTienda('https://noskipfee.co')).toBe(false);
    expect(esSubdominioDeTienda('https://malo-skipfee.co')).toBe(false);
    expect(esSubdominioDeTienda('https://arepas.skipfee.co.malo.com')).toBe(false);
  });

  it('rechaza dos niveles de subdominio', () => {
    expect(esSubdominioDeTienda('https://menu.arepas.skipfee.co')).toBe(false);
  });

  it('rechaza el dominio pelado y la basura', () => {
    expect(esSubdominioDeTienda('https://skipfee.co')).toBe(false);
    expect(esSubdominioDeTienda('no-es-una-url')).toBe(false);
    expect(esSubdominioDeTienda('')).toBe(false);
  });

  it('respeta las raíces configuradas', () => {
    process.env.STOREFRONT_WILDCARD_ROOTS = 'otrodominio.com';
    expect(esSubdominioDeTienda('https://arepas.otrodominio.com')).toBe(true);
    expect(esSubdominioDeTienda('https://arepas.skipfee.co')).toBe(false);
  });

  it('la vitrina es pública', () => {
    expect(isPublicPath('/api/storefront/arepas', 'GET')).toBe(true);
  });
});

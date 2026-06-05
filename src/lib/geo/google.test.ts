import { describe, it, expect, vi, beforeEach } from 'vitest';

const { envMock } = vi.hoisted(() => ({
  envMock: { GOOGLE_MAPS_API_KEY: 'test-key' as string | undefined },
}));
vi.mock('@/lib/env', () => ({ env: envMock }));

import { geocodeAddress } from './google';

const fetchMock = vi.fn();

function googleOk(locationType: string, partialMatch = false) {
  return {
    ok: true,
    json: async () => ({
      status: 'OK',
      results: [{
        geometry: { location: { lat: 6.2, lng: -75.56 }, location_type: locationType },
        formatted_address: 'Calle Falsa 123, Medellín',
        partial_match: partialMatch,
      }],
    }),
  };
}

beforeEach(() => {
  envMock.GOOGLE_MAPS_API_KEY = 'test-key';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('geocodeAddress', () => {
  it('ROOFTOP sin partial ⇒ confianza alta', async () => {
    fetchMock.mockResolvedValue(googleOk('ROOFTOP'));
    const r = await geocodeAddress('Cra 43A #5-15');
    expect(r?.confidence).toBe('alta');
    expect(r?.lat).toBe(6.2);
    expect(r?.lng).toBe(-75.56);
  });
  it('APPROXIMATE ⇒ confianza baja', async () => {
    fetchMock.mockResolvedValue(googleOk('APPROXIMATE'));
    expect((await geocodeAddress('Medellín'))?.confidence).toBe('baja');
  });
  it('partial_match ⇒ confianza baja aunque sea ROOFTOP', async () => {
    fetchMock.mockResolvedValue(googleOk('ROOFTOP', true));
    expect((await geocodeAddress('algo ambiguo'))?.confidence).toBe('baja');
  });
  it('ZERO_RESULTS ⇒ null', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'ZERO_RESULTS', results: [] }) });
    expect(await geocodeAddress('xyz')).toBeNull();
  });
  it('sin API key ⇒ null (no llama a fetch)', async () => {
    envMock.GOOGLE_MAPS_API_KEY = undefined;
    expect(await geocodeAddress('Cra 43A')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('fetch lanza ⇒ null', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    expect(await geocodeAddress('Cra 43A')).toBeNull();
  });
  it('texto vacío ⇒ null (no llama a fetch)', async () => {
    expect(await geocodeAddress('   ')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

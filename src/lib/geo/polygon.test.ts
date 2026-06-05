import { describe, it, expect } from 'vitest';
import { pointInPolygon, distanceMeters, resolveZone, type LatLng } from './polygon';

// Cuadrado (lat,lng): 0,0 — 0,10 — 10,10 — 10,0.
const SQUARE: LatLng[] = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: 10 },
  { lat: 10, lng: 10 },
  { lat: 10, lng: 0 },
];

describe('pointInPolygon', () => {
  it('punto interior ⇒ true', () => {
    expect(pointInPolygon({ lat: 5, lng: 5 }, SQUARE)).toBe(true);
  });
  it('punto exterior ⇒ false', () => {
    expect(pointInPolygon({ lat: 20, lng: 20 }, SQUARE)).toBe(false);
  });
  it('polígono con <3 vértices ⇒ false', () => {
    expect(pointInPolygon({ lat: 5, lng: 5 }, [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }])).toBe(false);
  });
});

describe('distanceMeters', () => {
  it('mismo punto ⇒ 0', () => {
    expect(distanceMeters({ lat: 6.2, lng: -75.5 }, { lat: 6.2, lng: -75.5 })).toBe(0);
  });
  it('~1 grado de latitud ≈ 111 km', () => {
    const d = distanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});

describe('resolveZone', () => {
  it('prioriza el polígono que contiene el punto', () => {
    const zones = [
      { id: 'a', lat: 0, lng: 0, coverage: SQUARE },
      {
        id: 'b', lat: 100, lng: 100, coverage: [
          { lat: 100, lng: 100 }, { lat: 100, lng: 110 },
          { lat: 110, lng: 110 }, { lat: 110, lng: 100 },
        ],
      },
    ];
    expect(resolveZone({ lat: 5, lng: 5 }, zones)).toBe('a');
  });
  it('respaldo por radio cuando no hay polígono', () => {
    const zones = [{ id: 'r', lat: 6.2, lng: -75.5, coverage: null, coverageRadiusM: 2000 }];
    expect(resolveZone({ lat: 6.205, lng: -75.5 }, zones)).toBe('r'); // ~555 m
    expect(resolveZone({ lat: 6.3, lng: -75.5 }, zones)).toBeNull(); // ~11 km
  });
  it('sin match ⇒ null', () => {
    expect(resolveZone({ lat: 50, lng: 50 }, [{ id: 'a', lat: 0, lng: 0, coverage: SQUARE }])).toBeNull();
  });
});

/**
 * Geometría para validar si un punto (lat/lng) cae dentro de una zona de
 * cobertura. Sin dependencias: ray-casting para polígonos + haversine para el
 * respaldo por radio. Suficiente para ~10 zonas; si crece, migrar a PostGIS.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface ZoneCoverage {
  id: string;
  lat: number;
  lng: number;
  /** Polígono de cobertura (≥3 vértices). null/ausente = sin polígono. */
  coverage?: LatLng[] | null;
  /** Respaldo: radio en metros desde (lat,lng) si no hay polígono. */
  coverageRadiusM?: number | null;
}

/**
 * Ray-casting. `polygon` es el anillo de vértices; no hace falta cerrarlo
 * (el primer y último vértice se conectan solos). Devuelve false con <3 puntos.
 */
export function pointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;
    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

const EARTH_RADIUS_M = 6_371_000;

/** Distancia en metros entre dos coordenadas (haversine). */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Devuelve el id de la primera zona que cubre el punto. Prioridad:
 *   1) polígono (point-in-polygon)
 *   2) respaldo por radio (coverageRadiusM desde el centro)
 * null = el punto no cae en ninguna zona (→ el flujo lo manda a humano).
 */
export function resolveZone(point: LatLng, zones: ZoneCoverage[]): string | null {
  for (const z of zones) {
    if (z.coverage && z.coverage.length >= 3 && pointInPolygon(point, z.coverage)) {
      return z.id;
    }
  }
  for (const z of zones) {
    if (z.coverageRadiusM && z.coverageRadiusM > 0) {
      if (distanceMeters(point, { lat: z.lat, lng: z.lng }) <= z.coverageRadiusM) {
        return z.id;
      }
    }
  }
  return null;
}

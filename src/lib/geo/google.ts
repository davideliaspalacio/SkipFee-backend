import { env } from '@/lib/env';

/**
 * Geocoding con Google Geocoding API. Convierte texto de dirección → lat/lng
 * con una señal de confianza (clave para no perder ventas ni cobrar mal el
 * domicilio): si la confianza es baja, el flujo pide compartir ubicación.
 *
 * Requiere GOOGLE_MAPS_API_KEY (server-side, con Geocoding API + billing).
 * Si no está configurada, devuelve null y el flujo cae al camino manual.
 */

export type GeoConfidence = 'alta' | 'baja';

export interface GeocodeResult {
  lat: number;
  lng: number;
  formatted: string;
  locationType: string;
  partialMatch: boolean;
  confidence: GeoConfidence;
}

interface GoogleGeocodeResponse {
  status: string;
  results?: Array<{
    geometry: { location: { lat: number; lng: number }; location_type: string };
    formatted_address: string;
    partial_match?: boolean;
  }>;
}

/** ¿Hay geocoding configurado? Si no, el flujo cae al camino manual de zona. */
export function geocodingEnabled(): boolean {
  return !!env.GOOGLE_MAPS_API_KEY;
}

// Tipos de ubicación de Google que consideramos precisos.
const HIGH_CONFIDENCE = new Set(['ROOFTOP', 'RANGE_INTERPOLATED']);

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

export async function geocodeAddress(
  address: string,
  opts: { signal?: AbortSignal } = {},
): Promise<GeocodeResult | null> {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    console.warn('[geo] GOOGLE_MAPS_API_KEY ausente — geocoding deshabilitado');
    return null;
  }
  const trimmed = address.trim();
  if (!trimmed) return null;

  const params = new URLSearchParams({
    address: trimmed,
    key,
    language: 'es',
    region: 'co',
    components: 'country:CO',
  });

  let res: Response;
  try {
    res = await fetch(`${GEOCODE_URL}?${params.toString()}`, { signal: opts.signal });
  } catch (err) {
    console.error('[geo] fetch geocode falló', err);
    return null;
  }
  if (!res.ok) {
    console.error('[geo] geocode HTTP', res.status);
    return null;
  }

  const data = (await res.json()) as GoogleGeocodeResponse;
  if (data.status !== 'OK' || !data.results || data.results.length === 0) {
    return null;
  }

  const top = data.results[0];
  const locationType = top.geometry.location_type;
  const partialMatch = top.partial_match ?? false;
  const confidence: GeoConfidence =
    HIGH_CONFIDENCE.has(locationType) && !partialMatch ? 'alta' : 'baja';

  return {
    lat: top.geometry.location.lat,
    lng: top.geometry.location.lng,
    formatted: top.formatted_address,
    locationType,
    partialMatch,
    confidence,
  };
}

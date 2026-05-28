import { supabaseAdmin } from '@/lib/db';

/**
 * Mapea coordenadas (lat, lng) a una zona conocida.
 * Estrategia: bbox (bounding box) por zona. Lo aproximado para el MVP;
 * después podemos usar polígonos reales con PostGIS.
 */
const ZONE_BBOX: Record<string, { latMin: number; latMax: number; lngMin: number; lngMax: number }> = {
  // Cajas aproximadas de las zonas de Medellín que sirve Bros and Subs.
  poblado:  { latMin: 6.180, latMax: 6.230, lngMin: -75.585, lngMax: -75.545 },
  envigado: { latMin: 6.155, latMax: 6.185, lngMin: -75.610, lngMax: -75.570 },
  laureles: { latMin: 6.230, latMax: 6.270, lngMin: -75.610, lngMax: -75.580 },
  fatima:   { latMin: 6.220, latMax: 6.255, lngMin: -75.620, lngMax: -75.590 },
};

export async function resolveZoneFromLatLng(lat: number, lng: number): Promise<string | null> {
  for (const [zoneId, box] of Object.entries(ZONE_BBOX)) {
    if (lat >= box.latMin && lat <= box.latMax && lng >= box.lngMin && lng <= box.lngMax) {
      // Confirmar que la zona existe en BD
      const { data } = await supabaseAdmin().from('zones').select('id').eq('id', zoneId).maybeSingle();
      if (data) return zoneId;
    }
  }
  return null;
}

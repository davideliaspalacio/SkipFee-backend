import { supabaseAdmin } from '@/lib/db';
import { resolveZone, type ZoneCoverage } from '@/lib/geo/polygon';

/**
 * Mapea coordenadas (lat,lng) a una zona de cobertura.
 * Lee las zonas activas (con su polígono `coverage` o radio de respaldo) y
 * delega en `resolveZone` (point-in-polygon + respaldo por radio).
 * Reemplaza el viejo enfoque de bounding-boxes hardcodeadas.
 */
export async function resolveZoneFromLatLng(lat: number, lng: number): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('zones')
    .select('id, lat, lng, coverage, coverage_radius_m')
    .eq('archived', false);
  if (error || !data) return null;

  const zones: ZoneCoverage[] = data.map(z => ({
    id: z.id as string,
    lat: z.lat as number,
    lng: z.lng as number,
    coverage: (z.coverage as ZoneCoverage['coverage']) ?? null,
    coverageRadiusM: (z.coverage_radius_m as number | null) ?? null,
  }));

  return resolveZone({ lat, lng }, zones);
}

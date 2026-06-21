import { supabaseAdmin } from '@/lib/db';
import { resolveZone, type ZoneCoverage } from '@/lib/geo/polygon';

/**
 * Mapea coordenadas (lat,lng) a una zona de cobertura.
 * Lee las zonas activas (con su polígono `coverage` o radio de respaldo) y
 * delega en `resolveZone` (point-in-polygon + respaldo por radio).
 * Reemplaza el viejo enfoque de bounding-boxes hardcodeadas.
 */
export async function resolveZoneFromLatLng(
  lat: number,
  lng: number,
  companyId?: string,
): Promise<{ zoneId: string | null; configured: boolean }> {
  // Solo las zonas de la empresa. Sin companyId (legacy), todas (single-tenant).
  let query = supabaseAdmin()
    .from('zones')
    .select('id, lat, lng, coverage, coverage_radius_m')
    .eq('archived', false);
  if (companyId) query = query.eq('company_id', companyId);
  const { data, error } = await query;
  if (error || !data) return { zoneId: null, configured: false };

  const zones: ZoneCoverage[] = data.map(z => ({
    id: z.id as string,
    lat: z.lat as number,
    lng: z.lng as number,
    coverage: (z.coverage as ZoneCoverage['coverage']) ?? null,
    coverageRadiusM: (z.coverage_radius_m as number | null) ?? null,
  }));

  // ¿Hay al menos una zona con cobertura definida (polígono o radio de respaldo)?
  const configured = zones.some(
    z => (z.coverage != null && z.coverage.length >= 3) || (z.coverageRadiusM != null && z.coverageRadiusM > 0),
  );
  return { zoneId: resolveZone({ lat, lng }, zones), configured };
}

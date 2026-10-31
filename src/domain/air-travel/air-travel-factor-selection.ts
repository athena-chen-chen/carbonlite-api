import { deriveAirTravelRoute, type AirTravelHaulCategory } from './air-travel';

type AirTravelFactorMetadata = {
  methodologyProvenance?: unknown;
};

function factorHaulCategory(factor: AirTravelFactorMetadata): AirTravelHaulCategory | null {
  const provenance = factor.methodologyProvenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return null;
  const category = String((provenance as Record<string, unknown>).haulCategory ?? '').toUpperCase();
  return category === 'SHORT' || category === 'MEDIUM' || category === 'LONG'
    ? category
    : null;
}

/** Air Travel factors fail closed unless their declared haul category matches
 * the category derived from server-owned airport metadata. Passenger-km alone
 * is deliberately insufficient to select a factor. */
export function airTravelFactorMatchesRoute(
  activityType: unknown,
  activityMetadata: unknown,
  factor: AirTravelFactorMetadata,
): boolean {
  if (String(activityType ?? '').trim().toUpperCase() !== 'AIR_TRAVEL') return true;
  const category = factorHaulCategory(factor);
  if (!category) return false;
  try {
    return deriveAirTravelRoute(activityMetadata).haulCategory === category;
  } catch {
    return false;
  }
}

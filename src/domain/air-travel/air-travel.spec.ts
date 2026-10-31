import {
  canonicalizeAirTravelActivity,
  classifyEpaHaul,
  deriveAirTravelRoute,
  normalizeAirTravelActivityMetadata,
} from './air-travel';
import { AIRPORTS_V1, AIRPORT_COORDINATE_DATASET } from './airports-v1';

const metadata = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, type: 'AIR_TRAVEL', originAirport: 'YYC', destinationAirport: 'YYZ',
  passengerCount: 1, tripType: 'ROUND_TRIP', ...overrides,
});

describe('Air Travel v0.1 route semantics', () => {
  it('vendors the paid-pilot airport coverage in the versioned OurAirports snapshot', () => {
    expect(AIRPORT_COORDINATE_DATASET.airportCount).toBe(9052);
    expect(AIRPORT_COORDINATE_DATASET.sourceSha256).toBe('6c600b7821829c2bd672c97b0c1e25b51a12e1e281fbd6fb1b698156b17d6acb');
    expect(['YYC', 'YYZ', 'YEG', 'YVR', 'JFK', 'SFO', 'ORD', 'LHR'].every(code => AIRPORTS_V1[code])).toBe(true);
  });

  it('derives YYC to YYZ from the versioned airport dataset before applying round-trip direction', () => {
    const route = deriveAirTravelRoute(metadata());
    expect(route.originAirport.iataCode).toBe('YYC');
    expect(route.destinationAirport.iataCode).toBe('YYZ');
    expect(route.airportDataset.version).toBe('2026-10-30');
    expect(route.oneWayDistanceKm).toBeCloseTo(2688.679313, 6);
    expect(route.oneWayDistanceMiles).toBeCloseTo(1670.66787, 6);
    expect(route.haulCategory).toBe('MEDIUM');
    expect(route.directionMultiplier).toBe(2);
    expect(route.itineraryDistanceKm).toBeCloseTo(route.oneWayDistanceKm * 2, 10);
    expect(route.passengerKm).toBeCloseTo(route.itineraryDistanceKm, 10);
  });

  it('classifies YYC to LHR as long and applies passengers and both directions', () => {
    const route = deriveAirTravelRoute(metadata({ destinationAirport: 'LHR', passengerCount: 2 }));
    expect(route.haulCategory).toBe('LONG');
    expect(route.passengerKm).toBeCloseTo(route.oneWayDistanceKm * 4, 10);
  });

  it('multiplies a one-way route by passenger count without doubling distance', () => {
    const route = deriveAirTravelRoute(metadata({ passengerCount: 3, tripType: 'ONE_WAY' }));
    expect(route.directionMultiplier).toBe(1);
    expect(route.passengerKm).toBeCloseTo(route.oneWayDistanceKm * 3, 10);
  });

  it('uses original mile thresholds', () => {
    expect(classifyEpaHaul(299.999)).toBe('SHORT');
    expect(classifyEpaHaul(300)).toBe('MEDIUM');
    expect(classifyEpaHaul(2299.999)).toBe('MEDIUM');
    expect(classifyEpaHaul(2300)).toBe('LONG');
  });

  it.each([
    [{ originAirport: 'XXX' }, 'Unknown IATA'],
    [{ destinationAirport: 'YYC' }, 'different'],
    [{ originAirport: undefined }, 'three-letter IATA'],
    [{ destinationAirport: undefined }, 'three-letter IATA'],
    [{ passengerCount: 0 }, 'positive integer'],
    [{ passengerCount: -1 }, 'positive integer'],
    [{ passengerCount: 1.5 }, 'positive integer'],
    [{ tripType: undefined }, 'Trip type'],
    [{ tripType: 'RETURN' }, 'Trip type'],
  ])('fails closed for invalid metadata %p', (overrides, message) => {
    expect(() => deriveAirTravelRoute(metadata(overrides))).toThrow(message);
  });

  it('ignores client-derived fields and returns server-derived canonical activity', () => {
    const result = canonicalizeAirTravelActivity({
      activityType: 'AIR_TRAVEL', quantity: 1, unit: 'km',
      activityMetadata: metadata({ passengerKm: 1, haulCategory: 'SHORT' }),
    });
    expect(result.unit).toBe('passenger-km');
    expect(result.quantity).toBeCloseTo(5377.3586266, 6);
    expect(result.derivedRoute?.haulCategory).toBe('MEDIUM');
    expect(result.activityMetadata).toEqual(normalizeAirTravelActivityMetadata(metadata()));
    expect(result.activityMetadata).not.toHaveProperty('passengerKm');
  });
});

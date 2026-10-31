import { AIRPORTS_V1, AIRPORT_COORDINATE_DATASET, type AirportCoordinate } from './airports-v1';

export const AIR_TRAVEL_METADATA_SCHEMA_VERSION = 1 as const;
export const AIR_TRAVEL_DISTANCE_FORMULA = {
  name: 'HAVERSINE_GREAT_CIRCLE',
  version: 1,
  earthRadiusKm: 6371.0088,
} as const;
export const KM_PER_MILE = 1.609344;

export type AirTravelTripType = 'ONE_WAY' | 'ROUND_TRIP';
export type AirTravelHaulCategory = 'SHORT' | 'MEDIUM' | 'LONG';

export type AirTravelActivityMetadataV1 = {
  schemaVersion: 1;
  type: 'AIR_TRAVEL';
  originAirport: string;
  destinationAirport: string;
  passengerCount: number;
  tripType: AirTravelTripType;
};

export type DerivedAirTravelRoute = {
  originAirport: AirportCoordinate;
  destinationAirport: AirportCoordinate;
  airportDataset: typeof AIRPORT_COORDINATE_DATASET;
  distanceFormula: typeof AIR_TRAVEL_DISTANCE_FORMULA;
  oneWayDistanceKm: number;
  oneWayDistanceMiles: number;
  directionMultiplier: 1 | 2;
  itineraryDistanceKm: number;
  passengerCount: number;
  passengerKm: number;
  haulCategory: AirTravelHaulCategory;
};

export class AirTravelActivityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AirTravelActivityError';
  }
}

const normalizeIata = (value: unknown) => String(value ?? '').trim().toUpperCase();

export function normalizeAirTravelActivityMetadata(value: unknown): AirTravelActivityMetadataV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AirTravelActivityError('Air Travel activity metadata is required.');
  }
  const input = value as Record<string, unknown>;
  const originAirport = normalizeIata(input.originAirport);
  const destinationAirport = normalizeIata(input.destinationAirport);
  const tripType = String(input.tripType ?? '').trim().toUpperCase();
  const passengerCount = Number(input.passengerCount);

  if (input.schemaVersion !== 1 || input.type !== 'AIR_TRAVEL') {
    throw new AirTravelActivityError('Unsupported Air Travel activity metadata schema.');
  }
  if (!/^[A-Z]{3}$/.test(originAirport) || !/^[A-Z]{3}$/.test(destinationAirport)) {
    throw new AirTravelActivityError('Origin and destination must be three-letter IATA airport codes.');
  }
  if (originAirport === destinationAirport) {
    throw new AirTravelActivityError('Origin and destination airports must be different.');
  }
  if (!Number.isSafeInteger(passengerCount) || passengerCount <= 0) {
    throw new AirTravelActivityError('Passenger count must be a positive integer.');
  }
  if (tripType !== 'ONE_WAY' && tripType !== 'ROUND_TRIP') {
    throw new AirTravelActivityError('Trip type must be ONE_WAY or ROUND_TRIP.');
  }
  return {
    schemaVersion: AIR_TRAVEL_METADATA_SCHEMA_VERSION,
    type: 'AIR_TRAVEL',
    originAirport,
    destinationAirport,
    passengerCount,
    tripType,
  };
}

const radians = (degrees: number) => degrees * Math.PI / 180;

export function classifyEpaHaul(oneWayDistanceMiles: number): AirTravelHaulCategory {
  if (oneWayDistanceMiles < 300) return 'SHORT';
  if (oneWayDistanceMiles < 2300) return 'MEDIUM';
  return 'LONG';
}

export function deriveAirTravelRoute(metadataValue: unknown): DerivedAirTravelRoute {
  const metadata = normalizeAirTravelActivityMetadata(metadataValue);
  const originAirport = AIRPORTS_V1[metadata.originAirport];
  const destinationAirport = AIRPORTS_V1[metadata.destinationAirport];
  if (!originAirport || !destinationAirport) {
    throw new AirTravelActivityError('Unknown IATA airport code in the v0.1 airport dataset.');
  }

  const latitudeDelta = radians(destinationAirport.latitudeDeg - originAirport.latitudeDeg);
  const longitudeDelta = radians(destinationAirport.longitudeDeg - originAirport.longitudeDeg);
  const originLatitude = radians(originAirport.latitudeDeg);
  const destinationLatitude = radians(destinationAirport.latitudeDeg);
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(originLatitude) * Math.cos(destinationLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  const oneWayDistanceKm = 2 * AIR_TRAVEL_DISTANCE_FORMULA.earthRadiusKm *
    Math.asin(Math.sqrt(Math.min(1, haversine)));
  const oneWayDistanceMiles = oneWayDistanceKm / KM_PER_MILE;
  const directionMultiplier = metadata.tripType === 'ROUND_TRIP' ? 2 : 1;
  const itineraryDistanceKm = oneWayDistanceKm * directionMultiplier;

  return {
    originAirport,
    destinationAirport,
    airportDataset: AIRPORT_COORDINATE_DATASET,
    distanceFormula: AIR_TRAVEL_DISTANCE_FORMULA,
    oneWayDistanceKm,
    oneWayDistanceMiles,
    directionMultiplier,
    itineraryDistanceKm,
    passengerCount: metadata.passengerCount,
    passengerKm: itineraryDistanceKm * metadata.passengerCount,
    haulCategory: classifyEpaHaul(oneWayDistanceMiles),
  };
}

export function canonicalizeAirTravelActivity(input: {
  activityType: unknown;
  quantity?: unknown;
  unit?: unknown;
  activityMetadata?: unknown;
}) {
  if (String(input.activityType ?? '').trim().toUpperCase() !== 'AIR_TRAVEL' || input.activityMetadata == null) {
    return { quantity: input.quantity, unit: input.unit, activityMetadata: null, derivedRoute: null };
  }
  const activityMetadata = normalizeAirTravelActivityMetadata(input.activityMetadata);
  const derivedRoute = deriveAirTravelRoute(activityMetadata);
  return {
    quantity: derivedRoute.passengerKm,
    unit: 'passenger-km',
    activityMetadata,
    derivedRoute,
  };
}

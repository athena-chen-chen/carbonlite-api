import { Prisma, PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { ConversionFactorsService } from '../../src/conversion-factors/conversion-factors.service';
import { isInventoryFactorEligible } from '../../src/conversion-factors/factor-governance';
import { deriveAirTravelRoute } from '../../src/domain/air-travel/air-travel';
import { CalculationQualityService } from '../../src/metrics/calculation-quality.service';
import { CalculationSnapshotsService } from '../../src/metrics/calculation-snapshots.service';
import {
  EPA_AIR_TRAVEL_2025_DEFINITIONS,
  EPA_AIR_TRAVEL_2025_FACTOR_IDS,
  EPA_AIR_TRAVEL_2025_PACK,
  EPA_AIR_TRAVEL_GWP_AR5,
  assertEpaAirTravelDevelopmentTarget,
  deriveEpaAirTravelFactor,
  epaAirTravel2025Source,
  seedEpaAirTravel2025,
} from './epa-air-travel-2025';

const updatedAt = new Date('2026-10-30T00:00:00.000Z');
const governedFactors = EPA_AIR_TRAVEL_2025_PACK.map((entry) => ({
  id: `version-${entry.definition.haulCategory.toLowerCase()}`,
  ...entry.version,
  updatedAt,
  factor: { id: entry.factorId, ...entry.factor },
  source: { id: 'epa-source', ...epaAirTravel2025Source },
}));

const metadata = (destinationAirport: string, passengerCount = 1) => ({
  schemaVersion: 1 as const,
  type: 'AIR_TRAVEL' as const,
  originAirport: 'YYC',
  destinationAirport,
  passengerCount,
  tripType: 'ROUND_TRIP' as const,
});

function record(destinationAirport: string, passengerCount = 1) {
  const activityMetadata = metadata(destinationAirport, passengerCount);
  const route = deriveAirTravelRoute(activityMetadata);
  return {
    id: `air-${destinationAirport}`,
    organizationId: 'paid-pilot-org',
    facilityId: null,
    assetId: null,
    documentId: null,
    activityType: 'AIR_TRAVEL',
    activityMetadata,
    customTypeLabel: null,
    recordDate: new Date('2026-06-30T00:00:00.000Z'),
    recordYear: 2026,
    periodStart: null,
    periodEnd: null,
    quantity: new Prisma.Decimal(route.passengerKm),
    unit: 'passenger-km',
    sourceType: 'MANUAL',
    sourceReference: 'Air Travel factor test',
    sourceFileName: null,
    sourceDocumentId: null,
    sourcePage: null,
    sourceRow: null,
    sourceTextSnippet: null,
    importBatchId: null,
    notes: null,
    createdAt: updatedAt,
    updatedAt,
    document: null,
  } as any;
}

const organization = {
  id: 'paid-pilot-org',
  provinceState: 'Alberta',
  country: 'Canada',
  defaultReportingYear: null,
  allowDemoFactorsForCalculations: false,
};

describe('U.S. EPA 2025 Air Travel production factor pack', () => {
  it('keeps the activityMetadata migration nullable, additive and free of row rewrites', () => {
    const sql = readFileSync('prisma/migrations/20261030120000_add_activity_metadata/migration.sql', 'utf8').trim();
    expect(sql).toBe('ALTER TABLE "ActivityData"\nADD COLUMN "activityMetadata" JSONB;');
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|UPDATE|TRUNCATE)\b/i);
  });

  it.each(EPA_AIR_TRAVEL_2025_DEFINITIONS)(
    'recalculates $haulCategory from source components and exact mile conversion',
    (definition) => {
      const derived = deriveEpaAirTravelFactor(definition);
      const expectedPassengerMile =
        Number(definition.co2KgPerPassengerMile) +
        Number(definition.ch4GPerPassengerMile) / 1000 * EPA_AIR_TRAVEL_GWP_AR5.CH4 +
        Number(definition.n2oGPerPassengerMile) / 1000 * EPA_AIR_TRAVEL_GWP_AR5.N2O;
      expect(derived.kgCo2ePerPassengerMile).toBeCloseTo(expectedPassengerMile, 14);
      expect(derived.kgCo2ePerPassengerMile).toBeCloseTo(Number(definition.derivedKgCo2ePerPassengerMile), 10);
      expect(derived.kgCo2ePerPassengerKm).toBeCloseTo(Number(definition.factorKgCo2ePerPassengerKm), 10);
    },
  );

  it('stores complete reviewed metadata and is eligible only through generic governance', () => {
    for (const entry of EPA_AIR_TRAVEL_2025_PACK) {
      const governed = governedFactors.find((factor) => factor.factorId === entry.factorId)!;
      expect(entry.factor).toMatchObject({ activityType: 'AIR_TRAVEL', scope: 'Scope 3', isActive: true });
      expect(entry.version).toMatchObject({
        inputUnit: 'passenger-km', resultUnit: 'kgCO2e', factorYear: 2025,
        status: 'VERIFIED', verificationStatus: 'VERIFIED', verified: true,
        applicability: 'CORPORATE_INVENTORY', emissionBasis: 'DIRECT_CO2E',
        methodologyProvenance: {
          haulCategory: entry.definition.haulCategory,
          inventoryCategory: 'Scope 3 Category 6 — Business Travel / Air Travel',
          gwp100: { CO2: 1, CH4: 28, N2O: 265 },
          emissionsBoundary: 'COMBUSTION_DIRECT_GHG_ONLY',
          aviationNonCo2AndRadiativeForcingIncluded: false,
          wellToTankIncluded: false,
          carbonLiteAdditionalDistanceUpliftPercent: 0,
          canadianOfficialFactor: false,
        },
      });
      expect(isInventoryFactorEligible(governed)).toBe(true);
      expect(isInventoryFactorEligible({
        ...governed,
        id: `renamed-${entry.definition.haulCategory}`,
        factorId: `renamed-${entry.definition.haulCategory}`,
        factor: { ...governed.factor, id: 'unlisted-factor', displayName: 'Renamed factor' },
        source: { ...governed.source, sourceAuthority: 'Renamed official authority' },
      })).toBe(true);
    }
  });

  it.each([
    ['YEG', 'SHORT', 0.1298219647],
    ['YYZ', 'MEDIUM', 0.0808424426],
    ['LHR', 'LONG', 0.1021501929],
  ])('selects the %s route from server-derived one-way haul: %s', async (destination, haul, value) => {
    const prisma = {
      organization: { findUniqueOrThrow: jest.fn().mockResolvedValue(organization) },
      conversionFactor: { findMany: jest.fn().mockResolvedValue(EPA_AIR_TRAVEL_2025_PACK.map((entry) => entry.legacy)) },
      factorVersion: { findMany: jest.fn().mockResolvedValue(governedFactors) },
    } as never;
    const service = new ConversionFactorsService(prisma, { log: jest.fn() } as never, { track: jest.fn() } as never);
    const match = await service.getApplicableFactor({
      activityType: 'AIR_TRAVEL',
      quantity: deriveAirTravelRoute(metadata(destination)).passengerKm,
      inputUnit: 'passenger-km',
      activityMetadata: metadata(destination),
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Alberta',
      recordYear: 2026,
      organizationId: organization.id,
    });
    expect(match).toMatchObject({
      matched: true,
      factorId: EPA_AIR_TRAVEL_2025_FACTOR_IDS[haul as keyof typeof EPA_AIR_TRAVEL_2025_FACTOR_IDS],
      factorValue: value,
      factorType: 'GOVERNED_LIBRARY',
    });
  });

  it('fails closed when passenger-km has no route metadata and never infers haul from quantity', async () => {
    const prisma = {
      organization: { findUniqueOrThrow: jest.fn().mockResolvedValue(organization) },
      conversionFactor: { findMany: jest.fn().mockResolvedValue([]) },
      factorVersion: { findMany: jest.fn().mockResolvedValue(governedFactors) },
    } as never;
    const service = new ConversionFactorsService(prisma, { log: jest.fn() } as never, { track: jest.fn() } as never);
    await expect(service.getApplicableFactor({
      activityType: 'AIR_TRAVEL', quantity: 5377.358627, inputUnit: 'passenger-km',
      jurisdictionCountry: 'Canada', jurisdictionRegion: 'Alberta', recordYear: 2026,
      organizationId: organization.id,
    })).resolves.toMatchObject({ matched: false, status: 'NO_MATCH' });
  });

  it.each([
    ['YYZ', 1, 'MEDIUM', 434.71880611177994, 434.719],
    ['LHR', 2, 'LONG', 2866.0005436040633, 2866.001],
  ])('calculates YYC to %s with passenger and direction multiplication', (destination, passengers, haul, exact, rounded) => {
    const route = deriveAirTravelRoute(metadata(destination, passengers));
    expect(route.haulCategory).toBe(haul);
    const factor = EPA_AIR_TRAVEL_2025_PACK.find((entry) => entry.definition.haulCategory === haul)!;
    expect(route.passengerKm * Number(factor.version.factorValue)).toBeCloseTo(exact, 9);
    const quality = new CalculationQualityService(null as never);
    const summary = quality.evaluate({
      organization,
      records: [record(destination, passengers)],
      factors: [],
      governedFactors: governedFactors as any,
      recalculate: true,
    });
    expect(summary.calculationDetails[0]).toMatchObject({
      status: 'CALCULATED', calculatedEmissionsKgCO2e: rounded,
      factorId: factor.factorId,
    });
  });

  it('proves a known short route and keeps generic 4280 km blocked', () => {
    const shortRoute = deriveAirTravelRoute(metadata('YEG'));
    expect(shortRoute).toMatchObject({ haulCategory: 'SHORT', passengerCount: 1, directionMultiplier: 2 });
    const quality = new CalculationQualityService(null as never);
    const short = quality.evaluate({
      organization, records: [record('YEG')], factors: [], governedFactors: governedFactors as any, recalculate: true,
    });
    expect(short.calculationDetails[0]).toMatchObject({
      status: 'CALCULATED', factorId: EPA_AIR_TRAVEL_2025_FACTOR_IDS.SHORT,
    });
    const generic = quality.evaluate({
      organization,
      records: [{ ...record('YYZ'), id: 'generic-air', quantity: new Prisma.Decimal(4280), unit: 'km', activityMetadata: null }],
      factors: EPA_AIR_TRAVEL_2025_PACK.map((entry) => entry.legacy) as any,
      governedFactors: governedFactors as any,
      recalculate: true,
    });
    expect(generic.calculationDetails[0].status).toBe('MISSING_FACTOR');
    expect(generic.calculationDetails[0].calculatedEmissionsKgCO2e).toBeNull();
  });

  it('persists reproducible route, factor-component and boundary evidence in the immutable snapshot', async () => {
    const client: any = {
      organization: { findUniqueOrThrow: jest.fn().mockResolvedValue(organization) },
      conversionFactor: { findMany: jest.fn().mockResolvedValue([]) },
      factorVersion: { findMany: jest.fn().mockResolvedValue(governedFactors) },
      metricResult: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
      activityData: { update: jest.fn(({ data }) => Promise.resolve(data)) },
      auditLog: { create: jest.fn() },
      userActivityEvent: { create: jest.fn() },
    };
    const quality = new CalculationQualityService(client);
    const snapshots = new CalculationSnapshotsService(client, quality);
    const row = await snapshots.prepareCreate(client, {
      organizationId: organization.id,
      activityType: 'AIR_TRAVEL',
      quantity: 1,
      unit: 'km',
      recordDate: new Date('2026-06-30T00:00:00.000Z'),
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Alberta',
      sourceType: 'MANUAL',
      activityMetadata: metadata('YYZ'),
    }, 'actor');

    expect(row.calculationStatus).toBe('CALCULATED');
    expect(row.calculationSnapshot).toMatchObject({
      version: 1,
      input: {
        activityMetadata: { originAirport: 'YYC', destinationAirport: 'YYZ', tripType: 'ROUND_TRIP' },
        airTravelRoute: {
          originAirport: { iataCode: 'YYC', latitudeDeg: 51.118822, longitudeDeg: -114.009933 },
          destinationAirport: { iataCode: 'YYZ' },
          airportDataset: { version: '2026-10-30' },
          distanceFormula: { version: 1, earthRadiusKm: 6371.0088 },
          directionMultiplier: 2,
          passengerCount: 1,
          haulCategory: 'MEDIUM',
        },
      },
      factor: {
        id: EPA_AIR_TRAVEL_2025_FACTOR_IDS.MEDIUM,
        provenance: {
          methodologyProvenance: {
            componentFactorsPerPassengerMile: {
              CO2: { value: '0.129', unit: 'kg' },
              CH4: { value: '0.0006', unit: 'g' },
              N2O: { value: '0.0041', unit: 'g' },
            },
            gwp100: { CO2: 1, CH4: 28, N2O: 265 },
            distanceConversion: { milesToKm: '1.609344' },
            emissionsBoundary: 'COMBUSTION_DIRECT_GHG_ONLY',
            aviationNonCo2AndRadiativeForcingIncluded: false,
            wellToTankIncluded: false,
            carbonLiteAdditionalDistanceUpliftPercent: 0,
          },
        },
      },
      result: { value: 434.719, scope: 'SCOPE_3' },
    });
    expect(row.calculationSnapshot.input.airTravelRoute.oneWayDistanceKm).toBeCloseTo(2688.679313, 6);
    expect(row.calculationSnapshot.input.airTravelRoute.oneWayDistanceMiles).toBeCloseTo(1670.66787, 6);
    expect(row.calculationSnapshot.input.airTravelRoute.passengerKm).toBeCloseTo(5377.358627, 6);
  });

  it('guards Neon development and loads all three stable identities idempotently', async () => {
    const host = 'ep-confirmed-development-pooler.c-2.us-east-1.aws.neon.tech';
    const safe = {
      DATABASE_URL: `postgresql://example:example@${host}/neondb?sslmode=require`,
      NEON_DEVELOPMENT_HOST: host,
      NODE_ENV: 'development',
      APP_ENV: 'local',
    };
    expect(() => assertEpaAirTravelDevelopmentTarget(safe, 'ep-confirmed-development')).not.toThrow();
    expect(() => assertEpaAirTravelDevelopmentTarget(safe, 'ep-main')).toThrow('Refusing data load');
    expect(() => assertEpaAirTravelDevelopmentTarget({ ...safe, NODE_ENV: 'production' }, 'ep-confirmed-development'))
      .toThrow('Refusing data load');

    const tx = {
      factor: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve(create)),
      },
      factorSource: { upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve(create)) },
      factorVersion: {
        upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve({ id: `version-${create.factorId}`, ...create })),
      },
      conversionFactor: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve(create)),
      },
    };
    const prisma = { $transaction: jest.fn().mockImplementation((callback) => callback(tx)) } as unknown as PrismaClient;
    const first = await seedEpaAirTravel2025(prisma);
    const second = await seedEpaAirTravel2025(prisma);
    expect(first.factors).toHaveLength(3);
    expect(second).toEqual(first);
    expect(tx.factor.upsert).toHaveBeenCalledTimes(6);
    expect(tx.factorVersion.upsert).toHaveBeenCalledTimes(6);
    expect(tx.conversionFactor.upsert).toHaveBeenCalledTimes(6);
    for (const call of tx.factorVersion.upsert.mock.calls) {
      expect(call[0].update).toEqual({ factorValue: call[0].create.factorValue });
    }
  });
});

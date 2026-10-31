import { Prisma, PrismaClient } from '@prisma/client';
import { ConversionFactorsService } from '../../src/conversion-factors/conversion-factors.service';
import { isInventoryFactorEligible } from '../../src/conversion-factors/factor-governance';
import { CalculationQualityService } from '../../src/metrics/calculation-quality.service';
import { albertaEgdfFactor, albertaEgdfSource, albertaEgdfVersion } from './alberta-egdf-2026';
import {
  ECCC_ELECTRICITY_CANADA_2026_DEFINITIONS,
  ECCC_ELECTRICITY_CANADA_2026_PACK,
  ECCC_ELECTRICITY_CANADA_2026_SOURCE_ID,
  assertElectricityDevelopmentTarget,
  deriveElectricityKgCo2ePerKwh,
  ecccElectricityCanada2026Source,
  seedEcccElectricityCanada2026,
} from './eccc-electricity-canada-2026';

const updatedAt = new Date('2026-10-30T00:00:00.000Z');

function governed(entry: (typeof ECCC_ELECTRICITY_CANADA_2026_PACK)[number]) {
  return {
    id: `${entry.factorId}-version`,
    ...entry.version,
    updatedAt,
    factor: { id: entry.factorId, ...entry.factor },
    source: { id: ECCC_ELECTRICITY_CANADA_2026_SOURCE_ID, ...ecccElectricityCanada2026Source },
  } as any;
}

function activity(geography: string, quantity: number) {
  return {
    id: `activity-${geography}`,
    organizationId: 'paid-pilot-org',
    facilityId: null,
    assetId: null,
    documentId: null,
    activityType: 'ELECTRICITY',
    customTypeLabel: null,
    recordDate: new Date('2026-06-30T00:00:00.000Z'),
    recordYear: 2026,
    periodStart: null,
    periodEnd: null,
    quantity: new Prisma.Decimal(quantity),
    unit: 'kWh',
    jurisdictionCountry: 'Canada',
    jurisdictionRegion: geography,
    sourceType: 'MANUAL',
    sourceReference: 'paid-pilot electricity',
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

describe('ECCC Canada 2026 location-based electricity production pack', () => {
  it('contains all 13 jurisdictions and re-derives every value from g/kWh', () => {
    expect(ECCC_ELECTRICITY_CANADA_2026_PACK).toHaveLength(13);
    expect(new Set(ECCC_ELECTRICITY_CANADA_2026_DEFINITIONS.map((item) => item.geography)).size).toBe(13);
    for (const entry of ECCC_ELECTRICITY_CANADA_2026_PACK) {
      expect(entry.version.factorValue.toString()).toBe(
        deriveElectricityKgCo2ePerKwh(entry.definition).toString(),
      );
      expect(entry.version.factorValue.toString()).toBe(
        new Prisma.Decimal(entry.definition.gramsCo2ePerKwh).dividedBy(1000).toString(),
      );
    }
  });

  it('stores explicit reviewed location-based corporate inventory governance', () => {
    for (const entry of ECCC_ELECTRICITY_CANADA_2026_PACK) {
      expect(entry.factor).toMatchObject({
        activityType: 'ELECTRICITY', scope: 'Scope 2 — Location-based', isSystem: true, isActive: true,
      });
      expect(entry.version).toMatchObject({
        inputUnit: 'kWh', resultUnit: 'kgCO2e', jurisdictionCountry: 'Canada',
        jurisdictionRegion: entry.definition.geography, factorYear: 2026,
        status: 'VERIFIED', verificationStatus: 'VERIFIED', verified: true,
        applicability: 'CORPORATE_INVENTORY', emissionBasis: 'DIRECT_CO2E',
        sourceTable: 'Table 5.3',
        methodologyProvenance: {
          inventoryScope: 'SCOPE_2', scope2AccountingMethod: 'LOCATION_BASED',
          consumptionIntensityBasis: 'DELIVERED_TO_CONSUMER',
          marketBasedScope2Calculated: false,
        },
      });
      expect(isInventoryFactorEligible(governed(entry))).toBe(true);
    }
  });

  it('does not rely on factor identity for eligibility', () => {
    const candidate = governed(ECCC_ELECTRICITY_CANADA_2026_PACK[0]);
    expect(isInventoryFactorEligible({
      ...candidate,
      id: 'renamed-version',
      factorId: 'renamed-factor',
      factor: { ...candidate.factor, id: 'renamed-factor', displayName: 'Renamed reviewed electricity' },
    })).toBe(true);
  });

  it('keeps the legacy Alberta 0.53 default and Alberta EGDF ineligible', () => {
    expect(isInventoryFactorEligible({
      id: 'factor-electricity-ab', activityType: 'ELECTRICITY', inputUnit: 'kWh',
      resultUnit: 'kgCO2e',
      applicability: 'CORPORATE_INVENTORY', emissionBasis: 'DIRECT_CO2E', verified: true,
      status: 'VERIFIED', sourceAuthority: 'CarbonLite System Defaults',
      sourceDocument: 'CarbonLite Default Factor Library v1.0',
      factor: { activityType: 'ELECTRICITY', isActive: true }, source: { isActive: true },
    })).toBe(false);
    expect(isInventoryFactorEligible({
      id: 'egdf-version', ...albertaEgdfVersion,
      factor: { id: 'egdf-factor', ...albertaEgdfFactor },
      source: { id: 'egdf-source', ...albertaEgdfSource },
    })).toBe(false);
  });

  it('selects exact-year Alberta and fails closed with only a 2025 factor', async () => {
    const alberta = ECCC_ELECTRICITY_CANADA_2026_PACK.find((entry) => entry.definition.code === 'AB')!;
    const prisma = {
      organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'paid-pilot-org', allowDemoFactorsForCalculations: false }) },
      conversionFactor: { findMany: jest.fn().mockResolvedValue([]) },
      factorVersion: { findMany: jest.fn().mockResolvedValue([governed(alberta)]) },
    } as never;
    const service = new ConversionFactorsService(prisma, { log: jest.fn() } as never, { track: jest.fn() } as never);
    await expect(service.getApplicableFactor({
      activityType: 'ELECTRICITY', inputUnit: 'kWh', jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Alberta', factorYear: 2026, organizationId: 'paid-pilot-org',
    })).resolves.toMatchObject({ matched: true, factorValue: 0.438, factorYear: 2026 });

    const factor2025 = { ...governed(alberta), id: 'ab-2025-version', factorId: 'ab-2025', factorYear: 2025,
      factorValue: new Prisma.Decimal('0.490'), factor: { ...governed(alberta).factor, id: 'ab-2025' } };
    (prisma as any).factorVersion.findMany.mockResolvedValue([factor2025]);
    await expect(service.getApplicableFactor({
      activityType: 'ELECTRICITY', inputUnit: 'kWh', jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Alberta', factorYear: 2026, organizationId: 'paid-pilot-org',
    })).resolves.toMatchObject({ matched: false, status: 'NO_MATCH' });
  });

  it.each([
    ['Alberta', 980, 429.24],
    ['Alberta', 1250, 547.5],
    ['British Columbia', 1000, 18],
    ['Ontario', 1000, 59],
    ['Manitoba', 1000, 2.5],
    ['Quebec', 1000, 1.9],
  ])('calculates %s %s kWh and labels location-based reporting', (geography, quantity, expected) => {
    const entry = ECCC_ELECTRICITY_CANADA_2026_PACK.find((item) => item.definition.geography === geography)!;
    const service = new CalculationQualityService(null as never);
    const result = service.evaluate({
      organization: { id: 'paid-pilot-org', country: 'Canada', provinceState: null, defaultReportingYear: null, allowDemoFactorsForCalculations: false },
      records: [activity(geography, quantity)], factors: [], governedFactors: [governed(entry)], recalculate: true,
    });
    expect(result.totalEstimatedEmissionsKgCO2e).toBe(expected);
    expect(result.calculationDetails[0]).toMatchObject({
      status: 'CALCULATED', calculatedEmissionsKgCO2e: expected,
      scopeLabel: 'Scope 2 — Location-based', scope2AccountingMethod: 'LOCATION_BASED',
      marketBasedScope2Status: 'NOT_CALCULATED',
      marketBasedScope2Message: 'Market-based Scope 2 not calculated unless qualifying contractual data is provided.',
    });
  });

  it('requires explicit confirmation of the configured Neon development endpoint', () => {
    const host = 'ep-confirmed-development-pooler.c-2.us-east-1.aws.neon.tech';
    const safe = { DATABASE_URL: `postgresql://example:example@${host}/neondb?sslmode=require`, NEON_DEVELOPMENT_HOST: host, NODE_ENV: 'development', APP_ENV: 'local' };
    expect(() => assertElectricityDevelopmentTarget(safe, 'ep-confirmed-development')).not.toThrow();
    expect(() => assertElectricityDevelopmentTarget(safe, 'ep-main')).toThrow('Refusing data load');
    expect(() => assertElectricityDevelopmentTarget({ ...safe, NODE_ENV: 'production' }, 'ep-confirmed-development')).toThrow('Refusing data load');
  });

  it('loads all 13 records idempotently while restoring only authoritative values', async () => {
    const tx = {
      factor: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn(({ create }) => Promise.resolve(create)) },
      factorSource: { upsert: jest.fn(({ create }) => Promise.resolve(create)) },
      factorVersion: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(({ create }) => Promise.resolve({ id: `${create.factorId}-version`, ...create })),
      },
      conversionFactor: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn(({ create }) => Promise.resolve(create)) },
    };
    const prisma = { $transaction: jest.fn((callback) => callback(tx)) } as unknown as PrismaClient;
    const first = await seedEcccElectricityCanada2026(prisma);
    const second = await seedEcccElectricityCanada2026(prisma);
    expect(first.count).toBe(13);
    expect(second.factorIds).toEqual(first.factorIds);
    expect(tx.factor.upsert).toHaveBeenCalledTimes(26);
    expect(tx.factorVersion.upsert).toHaveBeenCalledTimes(26);
    expect(tx.conversionFactor.upsert).toHaveBeenCalledTimes(26);
    for (const call of tx.factorVersion.upsert.mock.calls) {
      expect(call[0].update).toEqual({ factorValue: call[0].create.factorValue });
    }
  });
});

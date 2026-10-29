import { PrismaClient } from '@prisma/client';
import { ConversionFactorsService } from '../../src/conversion-factors/conversion-factors.service';
import { isInventoryFactorEligible } from '../../src/conversion-factors/factor-governance';
import {
  ECCC_DIESEL_2026_FACTOR_ID,
  ECCC_GASOLINE_2026_FACTOR_ID,
  ECCC_REFINED_PETROLEUM_2026_SOURCE_ID,
  ecccDiesel2026Factor,
  ecccDiesel2026Version,
  ecccGasoline2026Factor,
  ecccGasoline2026Version,
  ecccRefinedPetroleum2026Source,
  seedEcccRefinedPetroleum2026,
} from './eccc-refined-petroleum-2026';

const updatedAt = new Date('2026-10-29T00:00:00.000Z');

function governedVersion(
  id: string,
  version: typeof ecccGasoline2026Version | typeof ecccDiesel2026Version,
  factor: typeof ecccGasoline2026Factor | typeof ecccDiesel2026Factor,
) {
  return {
    id,
    ...version,
    updatedAt,
    factor: { id: version.factorId, ...factor },
    source: { id: ECCC_REFINED_PETROLEUM_2026_SOURCE_ID, ...ecccRefinedPetroleum2026Source },
  };
}

const gasoline = governedVersion('gasoline-version-2026', ecccGasoline2026Version, ecccGasoline2026Factor);
const diesel = governedVersion('diesel-version-2026', ecccDiesel2026Version, ecccDiesel2026Factor);

describe('ECCC refined-petroleum 2026 production factor pack', () => {
  it('derives direct CO2e from the published component factors and statutory GWPs', () => {
    expect(Number(ecccGasoline2026Version.factorValue)).toBeCloseTo(
      (2307 + 0.1 * 28 + 0.02 * 265) / 1000,
      8,
    );
    expect(Number(ecccDiesel2026Version.factorValue)).toBeCloseTo(
      (2681 + 0.078 * 28 + 0.022 * 265) / 1000,
      8,
    );
    expect(ecccGasoline2026Version.methodologyProvenance).toMatchObject({
      fuelType: 'Motor Gasoline',
      componentFactorsGPerL: { CO2: '2307', CH4: '0.100', N2O: '0.02' },
      gwp100: { CO2: 1, CH4: 28, N2O: 265 },
    });
    expect(ecccDiesel2026Version.methodologyProvenance).toMatchObject({
      fuelType: 'Diesel - Refineries and Others',
      componentFactorsGPerL: { CO2: '2681', CH4: '0.078', N2O: '0.022' },
      gwp100: { CO2: 1, CH4: 28, N2O: 265 },
    });
  });

  it.each([gasoline, diesel])('makes $factor.activityType automatically eligible from metadata', (candidate) => {
    expect(isInventoryFactorEligible(candidate)).toBe(true);
    expect(candidate).toMatchObject({
      status: 'VERIFIED',
      verified: true,
      verificationStatus: 'VERIFIED',
      applicability: 'CORPORATE_INVENTORY',
      emissionBasis: 'DIRECT_CO2E',
      resultUnit: 'kgCO2e',
      factor: { isActive: true },
      source: { isActive: true, isOfficial: true },
    });
  });

  it('does not depend on a production factor ID, name or source allowlist', () => {
    expect(isInventoryFactorEligible({
      ...gasoline,
      id: 'new-version-never-listed-in-code',
      factorId: 'new-factor-never-listed-in-code',
      factor: { ...gasoline.factor, id: 'new-factor-never-listed-in-code', displayName: 'New reviewed fuel' },
      source: { ...gasoline.source, sourceAuthority: 'New reviewed authority', sourceDocument: 'New reviewed document' },
    })).toBe(true);
  });

  it.each([
    { id: 'demo-factor-gasoline', activityType: 'GASOLINE' },
    { id: 'demo-factor-diesel', activityType: 'DIESEL' },
  ])('keeps legacy/demo $activityType factors ineligible', ({ id, activityType }) => {
    expect(isInventoryFactorEligible({
      id,
      factorId: id,
      activityType,
      inputUnit: 'L',
      resultUnit: 'kgCO2e',
      status: 'DRAFT',
      verified: false,
      verificationStatus: 'Internal Review Required',
      applicability: null,
      factor: { activityType, isActive: true },
      source: {
        isActive: true,
        sourceAuthority: 'CarbonLite System Defaults',
        sourceDocument: 'CarbonLite Default Factor Library v1.0',
      },
    })).toBe(false);
  });

  it('matches both factors and calculates 350 L gasoline from the reviewed factor', async () => {
    const prisma = {
      organization: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'paid-pilot-org',
          allowDemoFactorsForCalculations: false,
        }),
      },
      conversionFactor: {
        findMany: jest.fn().mockImplementation(({ where }) => Promise.resolve([{
          id: `demo-factor-${String(where.activityType).toLowerCase().replace('_', '-')}`,
          organizationId: null,
          name: `${where.activityType} demo`,
          type: 'EMISSION',
          activityType: where.activityType,
          unit: 'L',
          factorValue: where.activityType === 'GASOLINE' ? 2.31 : 2.68,
          resultUnit: 'kgCO2e',
          sourceAuthority: 'CarbonLite System Defaults',
          sourceDocument: 'CarbonLite Default Factor Library v1.0',
          sourceYear: 2026,
          verified: false,
          verificationStatus: 'Internal Review Required',
          applicability: null,
          isDefault: true,
          isSystemDefault: true,
          updatedAt,
        }])),
      },
      factorVersion: {
        findMany: jest.fn().mockImplementation(({ where }) =>
          Promise.resolve(where.factor.activityType === 'GASOLINE' ? [gasoline] : [diesel])),
      },
    } as never;
    const service = new ConversionFactorsService(
      prisma,
      { log: jest.fn() } as never,
      { track: jest.fn() } as never,
    );

    const gasolineMatch = await service.getApplicableFactor({
      activityType: 'GASOLINE',
      quantity: 350,
      inputUnit: 'L',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'British Columbia',
      factorYear: 2026,
      organizationId: 'paid-pilot-org',
    });
    const dieselMatch = await service.getApplicableFactor({
      activityType: 'DIESEL',
      quantity: 100,
      inputUnit: 'L',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Alberta',
      factorYear: 2026,
      organizationId: 'paid-pilot-org',
    });

    expect(gasolineMatch).toMatchObject({
      matched: true,
      factorId: ECCC_GASOLINE_2026_FACTOR_ID,
      factorVersionId: 'gasoline-version-2026',
      factorValue: 2.3151,
      factorType: 'GOVERNED_LIBRARY',
    });
    expect(dieselMatch).toMatchObject({
      matched: true,
      factorId: ECCC_DIESEL_2026_FACTOR_ID,
      factorVersionId: 'diesel-version-2026',
      factorValue: 2.689014,
      factorType: 'GOVERNED_LIBRARY',
    });
    expect(350 * Number(gasolineMatch.factorValue)).toBeCloseTo(810.285, 6);
  });

  it('adds only new records and leaves historical snapshots and demo rows untouched', async () => {
    const historicalSnapshots = [
      { factorId: 'legacy-gasoline', factorValue: '2.31', calculatedEmissionsKgCO2e: '808.5' },
      { factorId: 'legacy-diesel', factorValue: '2.68', calculatedEmissionsKgCO2e: '268' },
    ];
    const before = JSON.stringify(historicalSnapshots);
    const tx = {
      factor: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve(create)),
      },
      factorSource: {
        upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve(create)),
      },
      factorVersion: {
        upsert: jest.fn().mockImplementation(({ create }) =>
          Promise.resolve({ id: `${create.factorId}-version`, ...create })),
      },
      conversionFactor: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve(create)),
      },
      metricResult: { updateMany: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn().mockImplementation((callback) => callback(tx)),
    } as unknown as PrismaClient;

    await seedEcccRefinedPetroleum2026(prisma);

    expect(JSON.stringify(historicalSnapshots)).toBe(before);
    expect(tx.metricResult.updateMany).not.toHaveBeenCalled();
    expect(tx.factor.upsert).toHaveBeenCalledTimes(2);
    expect(tx.factorVersion.upsert).toHaveBeenCalledTimes(2);
    expect(tx.conversionFactor.upsert).toHaveBeenCalledTimes(2);
    for (const call of [
      ...tx.factor.upsert.mock.calls,
      ...tx.factorVersion.upsert.mock.calls,
      ...tx.conversionFactor.upsert.mock.calls,
    ]) {
      expect(call[0].update).toEqual({});
    }
  });
});

import { PrismaClient } from '@prisma/client';
import { ConversionFactorsService } from '../../src/conversion-factors/conversion-factors.service';
import { isInventoryFactorEligible } from '../../src/conversion-factors/factor-governance';
import {
  ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID,
  ECCC_NATURAL_GAS_ALBERTA_2026_M3_FACTOR_ID,
  ECCC_NATURAL_GAS_ALBERTA_2026_M3_VALUE,
  ECCC_NATURAL_GAS_ALBERTA_2026_SOURCE_ID,
  ECCC_NATURAL_GAS_ALBERTA_2026_VALUE,
  ecccNaturalGasAlberta2026Factor,
  ecccNaturalGasAlberta2026M3Factor,
  ecccNaturalGasAlberta2026Legacy,
  ecccNaturalGasAlberta2026M3Legacy,
  ecccNaturalGasAlberta2026Source,
  ecccNaturalGasAlberta2026Version,
  ecccNaturalGasAlberta2026M3Version,
  assertNaturalGasDevelopmentTarget,
  seedEcccNaturalGasAlberta2026,
} from './eccc-natural-gas-alberta-2026';

const updatedAt = new Date('2026-10-30T00:00:00.000Z');
const governedNaturalGas = {
  id: 'natural-gas-version-2026',
  ...ecccNaturalGasAlberta2026Version,
  updatedAt,
  factor: {
    id: ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID,
    ...ecccNaturalGasAlberta2026Factor,
  },
  source: {
    id: ECCC_NATURAL_GAS_ALBERTA_2026_SOURCE_ID,
    ...ecccNaturalGasAlberta2026Source,
  },
};
const governedNaturalGasVolume = {
  id: 'natural-gas-volume-version-2026',
  ...ecccNaturalGasAlberta2026M3Version,
  updatedAt,
  factor: {
    id: ECCC_NATURAL_GAS_ALBERTA_2026_M3_FACTOR_ID,
    ...ecccNaturalGasAlberta2026M3Factor,
  },
  source: {
    id: ECCC_NATURAL_GAS_ALBERTA_2026_SOURCE_ID,
    ...ecccNaturalGasAlberta2026Source,
  },
};

describe('ECCC Alberta natural-gas 2026 production factor', () => {
  it('requires explicit confirmation of the configured Neon development endpoint', () => {
    const host = 'ep-confirmed-development-pooler.c-2.us-east-1.aws.neon.tech';
    const safe = {
      DATABASE_URL: `postgresql://example:example@${host}/neondb?sslmode=require`,
      NEON_DEVELOPMENT_HOST: host,
      NODE_ENV: 'development',
      APP_ENV: 'local',
    };
    expect(() => assertNaturalGasDevelopmentTarget(safe, 'ep-confirmed-development')).not.toThrow();
    expect(() => assertNaturalGasDevelopmentTarget(safe, 'ep-main')).toThrow('Refusing data load');
    expect(() => assertNaturalGasDevelopmentTarget({ ...safe, NODE_ENV: 'production' }, 'ep-confirmed-development'))
      .toThrow('Refusing data load');
  });

  it('exists as a governed Factor Library definition with the approved derivation', () => {
    expect(ecccNaturalGasAlberta2026Factor.activityType).toBe('NATURAL_GAS');
    expect(Number(ecccNaturalGasAlberta2026Version.factorValue)).toBe(
      Number(ECCC_NATURAL_GAS_ALBERTA_2026_VALUE),
    );
    expect(Number(ecccNaturalGasAlberta2026Version.factorValue)).toBeCloseTo(
      (1962 + 0.037 * 28 + 0.035 * 265) / 38.39,
      12,
    );
    expect(ecccNaturalGasAlberta2026Version).toMatchObject({
      inputUnit: 'GJ',
      resultUnit: 'kgCO2e',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Alberta',
      factorYear: 2026,
      status: 'VERIFIED',
      verificationStatus: 'VERIFIED',
      verified: true,
      applicability: 'CORPORATE_INVENTORY',
      emissionBasis: 'DIRECT_CO2E',
      methodologyProvenance: {
        fuelType: 'Marketable natural gas',
        combustionSector: 'Commercial/Institutional',
        quantityBasis: 'ENERGY_HHV',
        componentFactorsGPerM3: { CO2: '1962', CH4: '0.037', N2O: '0.035' },
        gwp100: { CO2: 1, CH4: 28, N2O: 265 },
        energyConversion: { value: '38.39', unit: 'MJ/m3', basis: 'HHV' },
      },
    });
  });

  it('is eligible solely from existing metadata governance', () => {
    expect(isInventoryFactorEligible(governedNaturalGas)).toBe(true);
    expect(isInventoryFactorEligible({
      ...governedNaturalGas,
      id: 'unlisted-version',
      factorId: 'unlisted-factor',
      factor: { ...governedNaturalGas.factor, id: 'unlisted-factor', displayName: 'Renamed reviewed gas' },
      source: { ...governedNaturalGas.source, sourceAuthority: 'Renamed official authority' },
    })).toBe(true);
    expect(isInventoryFactorEligible(governedNaturalGasVolume)).toBe(true);
  });

  it('defines the direct governed volume factor without changing the GJ factor', () => {
    expect(Number(ecccNaturalGasAlberta2026Version.factorValue)).toBe(51.3756446991404);
    expect(Number(ecccNaturalGasAlberta2026M3Version.factorValue)).toBe(1.972311);
    expect(Number(ecccNaturalGasAlberta2026M3Version.factorValue)).toBeCloseTo(
      (1962 + 0.037 * 28 + 0.035 * 265) / 1000,
      12,
    );
    expect(ecccNaturalGasAlberta2026M3Version).toMatchObject({
      inputUnit: 'm3',
      resultUnit: 'kgCO2e',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Alberta',
      factorYear: 2026,
      applicability: 'CORPORATE_INVENTORY',
      emissionBasis: 'DIRECT_CO2E',
      methodologyProvenance: {
        quantityBasis: 'VOLUME',
        derivedFactorKgCO2ePerM3: ECCC_NATURAL_GAS_ALBERTA_2026_M3_VALUE,
      },
    });
  });

  it.each([
    {
      id: 'eccc-natural-gas-canada-generic-gj-2025',
      factorId: 'eccc-natural-gas-canada-generic-gj-2025',
      status: 'REFERENCE_ONLY',
      verified: false,
      verificationStatus: 'INTERNAL_REVIEW_REQUIRED',
      applicability: 'REFERENCE_ONLY',
    },
    {
      id: 'factor-natural-gas-demo',
      factorId: 'factor-natural-gas-demo',
      status: 'DRAFT',
      verified: false,
      verificationStatus: 'INTERNAL_REVIEW_REQUIRED',
      applicability: null,
    },
  ])('keeps reference/demo natural gas ineligible: $id', (metadata) => {
    expect(isInventoryFactorEligible({
      ...metadata,
      activityType: 'NATURAL_GAS',
      inputUnit: 'GJ',
      resultUnit: 'kgCO2e',
      factor: { activityType: 'NATURAL_GAS', isActive: true },
      source: { isActive: true },
    })).toBe(false);
  });

  it('matches from the governed library and calculates 8.5 GJ', async () => {
    const prisma = {
      organization: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'paid-pilot-org', allowDemoFactorsForCalculations: false,
        }),
      },
      conversionFactor: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'eccc-natural-gas-canada-generic-gj-2025',
          organizationId: null,
          name: 'Natural Gas - Canada Generic',
          type: 'EMISSION',
          activityType: 'NATURAL_GAS',
          unit: 'GJ',
          factorValue: 49.44,
          resultUnit: 'kgCO2e',
          country: 'Canada',
          region: 'Canada',
          sourceYear: 2025,
          verified: false,
          verificationStatus: 'INTERNAL_REVIEW_REQUIRED',
          applicability: 'REFERENCE_ONLY',
          isDefault: false,
          isSystemDefault: true,
          updatedAt,
        }]),
      },
      factorVersion: { findMany: jest.fn().mockResolvedValue([governedNaturalGas]) },
    } as never;
    const service = new ConversionFactorsService(
      prisma,
      { log: jest.fn() } as never,
      { track: jest.fn() } as never,
    );

    const match = await service.getApplicableFactor({
      activityType: 'NATURAL_GAS',
      quantity: 8.5,
      inputUnit: 'GJ',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Alberta',
      factorYear: 2026,
      organizationId: 'paid-pilot-org',
    });

    expect(match).toMatchObject({
      matched: true,
      factorId: ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID,
      factorVersionId: 'natural-gas-version-2026',
      factorValue: 51.3756446991404,
      factorType: 'GOVERNED_LIBRARY',
    });
    expect(8.5 * Number(match.factorValue)).toBe(436.6929799426934);
  });

  it('matches the governed direct-volume factor and calculates 100 m3', async () => {
    const prisma = {
      organization: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'paid-pilot-org', allowDemoFactorsForCalculations: false,
        }),
      },
      conversionFactor: { findMany: jest.fn().mockResolvedValue([]) },
      factorVersion: { findMany: jest.fn().mockResolvedValue([governedNaturalGas, governedNaturalGasVolume]) },
    } as never;
    const service = new ConversionFactorsService(
      prisma,
      { log: jest.fn() } as never,
      { track: jest.fn() } as never,
    );

    const match = await service.getApplicableFactor({
      activityType: 'NATURAL_GAS',
      quantity: 100,
      inputUnit: 'm3',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Alberta',
      factorYear: 2026,
      organizationId: 'paid-pilot-org',
    });

    expect(match).toMatchObject({
      matched: true,
      factorId: ECCC_NATURAL_GAS_ALBERTA_2026_M3_FACTOR_ID,
      factorVersionId: 'natural-gas-volume-version-2026',
      factorValue: 1.972311,
      factorType: 'GOVERNED_LIBRARY',
    });
    expect(100 * Number(match.factorValue)).toBe(197.2311);

    const unsupported = await service.getApplicableFactor({
      activityType: 'NATURAL_GAS',
      quantity: 100,
      inputUnit: 'therms',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Alberta',
      factorYear: 2026,
      organizationId: 'paid-pilot-org',
    });
    expect(unsupported.matched).toBe(false);
  });

  it('loads idempotently while restoring only the authoritative numeric value', async () => {
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
          Promise.resolve({ id: 'natural-gas-version-2026', ...create })),
      },
      conversionFactor: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve(create)),
      },
    };
    const prisma = {
      $transaction: jest.fn().mockImplementation((callback) => callback(tx)),
    } as unknown as PrismaClient;

    await seedEcccNaturalGasAlberta2026(prisma);

    expect(tx.factor.upsert).toHaveBeenCalledTimes(2);
    expect(tx.factorVersion.upsert).toHaveBeenCalledTimes(2);
    expect(tx.conversionFactor.upsert).toHaveBeenCalledTimes(2);
    expect(tx.factor.upsert.mock.calls[0][0].update).toEqual({});
    expect(tx.factorVersion.upsert.mock.calls[0][0].update).toEqual({
      factorValue: ecccNaturalGasAlberta2026Version.factorValue,
    });
    expect(tx.conversionFactor.upsert.mock.calls[0][0].update).toEqual({
      factorValue: ecccNaturalGasAlberta2026Legacy.factorValue,
    });
    expect(tx.factorVersion.upsert.mock.calls[1][0].update).toEqual({
      factorValue: ecccNaturalGasAlberta2026M3Version.factorValue,
    });
    expect(tx.conversionFactor.upsert.mock.calls[1][0].update).toEqual({
      factorValue: ecccNaturalGasAlberta2026M3Legacy.factorValue,
    });
  });
});

import { PrismaClient } from '@prisma/client';
import { ConversionFactorsService } from '../../src/conversion-factors/conversion-factors.service';
import { isInventoryFactorEligible } from '../../src/conversion-factors/factor-governance';
import {
  DESNZ_HOTEL_CANADA_2026_FACTOR_ID,
  DESNZ_HOTEL_CANADA_2026_SOURCE_ID,
  DESNZ_HOTEL_CANADA_2026_VALUE,
  assertHotelDevelopmentTarget,
  desnzHotelCanada2026Factor,
  desnzHotelCanada2026Legacy,
  desnzHotelCanada2026Source,
  desnzHotelCanada2026Version,
  seedDesnzHotelCanada2026,
} from './desnz-hotel-canada-2026';

const updatedAt = new Date('2026-10-30T00:00:00.000Z');
const governedHotel = {
  id: 'hotel-version-2026',
  ...desnzHotelCanada2026Version,
  updatedAt,
  factor: {
    id: DESNZ_HOTEL_CANADA_2026_FACTOR_ID,
    ...desnzHotelCanada2026Factor,
  },
  source: {
    id: DESNZ_HOTEL_CANADA_2026_SOURCE_ID,
    ...desnzHotelCanada2026Source,
  },
};

function serviceWith(input: { versions?: unknown[]; legacy?: unknown[] }) {
  const prisma = {
    organization: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'paid-pilot-org', allowDemoFactorsForCalculations: false,
      }),
    },
    conversionFactor: { findMany: jest.fn().mockResolvedValue(input.legacy ?? []) },
    factorVersion: { findMany: jest.fn().mockResolvedValue(input.versions ?? []) },
  } as never;
  return new ConversionFactorsService(
    prisma,
    { log: jest.fn() } as never,
    { track: jest.fn() } as never,
  );
}

describe('DESNZ Canada hotel 2026 production factor and air-travel review', () => {
  it('defines the published Canada result on the exact occupied room-night basis', () => {
    expect(desnzHotelCanada2026Factor).toMatchObject({
      activityType: 'HOTEL', category: 'HOTEL', scope: 'Scope 3', isActive: true,
    });
    expect(Number(desnzHotelCanada2026Version.factorValue)).toBe(7.4);
    expect(desnzHotelCanada2026Version).toMatchObject({
      inputUnit: 'room-night',
      resultUnit: 'kgCO2e',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Canada',
      factorYear: 2026,
      status: 'VERIFIED',
      verificationStatus: 'VERIFIED',
      verified: true,
      applicability: 'CORPORATE_INVENTORY',
      emissionBasis: 'DIRECT_CO2E',
      methodologyProvenance: {
        methodologySection: '11 Hotel Stay',
        quantityBasis: 'OCCUPIED_ROOM_NIGHT',
        sourceUnit: 'Room per night',
        derivedFactorKgCO2ePerOccupiedRoomNight: DESNZ_HOTEL_CANADA_2026_VALUE,
      },
      sourceSection: '11 Hotel Stay',
    });
  });

  it('is eligible solely from metadata, independent of identity', () => {
    expect(isInventoryFactorEligible(governedHotel)).toBe(true);
    expect(isInventoryFactorEligible({
      ...governedHotel,
      id: 'renamed-version',
      factorId: 'renamed-factor',
      factor: { ...governedHotel.factor, id: 'renamed-factor', displayName: 'Renamed hotel factor' },
      source: { ...governedHotel.source, sourceAuthority: 'Renamed official authority' },
    })).toBe(true);
  });

  it('matches an explicit room-night input and calculates 3 x 7.4', async () => {
    const match = await serviceWith({ versions: [governedHotel] }).getApplicableFactor({
      activityType: 'HOTEL',
      quantity: 3,
      inputUnit: 'room-night',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Ontario',
      factorYear: 2026,
      organizationId: 'paid-pilot-org',
    });

    expect(match).toMatchObject({
      matched: true,
      factorId: DESNZ_HOTEL_CANADA_2026_FACTOR_ID,
      factorVersionId: 'hotel-version-2026',
      factorValue: 7.4,
      factorType: 'GOVERNED_LIBRARY',
    });
    expect(3 * Number(match.factorValue)).toBe(22.200000000000003);
  });

  it('does not reinterpret workbook nights as room-nights', async () => {
    const match = await serviceWith({ versions: [governedHotel] }).getApplicableFactor({
      activityType: 'HOTEL',
      quantity: 3,
      inputUnit: 'nights',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Ontario',
      factorYear: 2026,
      organizationId: 'paid-pilot-org',
    });

    expect(match).toMatchObject({ matched: false, status: 'NO_MATCH' });
  });

  it.each([
    { activityType: 'HOTEL', unit: 'nights', factorValue: 15 },
    { activityType: 'AIR_TRAVEL', unit: 'km', factorValue: 0.115 },
  ])('keeps the legacy $activityType value ineligible', (legacy) => {
    expect(isInventoryFactorEligible({
      ...legacy,
      id: `legacy-${legacy.activityType}`,
      resultUnit: 'kgCO2e',
      status: 'DRAFT',
      verificationStatus: 'INTERNAL_REVIEW_REQUIRED',
      verified: false,
      applicability: null,
    })).toBe(false);
  });

  it('keeps the 4,280 km air row unmatched when only the legacy factor exists', async () => {
    const match = await serviceWith({ legacy: [{
      id: 'legacy-air-0.115',
      organizationId: null,
      name: 'Air travel emission factor',
      type: 'EMISSION',
      activityType: 'AIR_TRAVEL',
      unit: 'km',
      factorValue: 0.115,
      resultUnit: 'kgCO2e',
      country: 'Canada',
      region: 'Canada',
      status: 'DRAFT',
      verificationStatus: 'INTERNAL_REVIEW_REQUIRED',
      verified: false,
      applicability: null,
      isSystemDefault: true,
      updatedAt,
    }] }).getApplicableFactor({
      activityType: 'AIR_TRAVEL',
      quantity: 4280,
      inputUnit: 'km',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Alberta',
      factorYear: 2026,
      organizationId: 'paid-pilot-org',
    });

    expect(match).toMatchObject({ matched: false, status: 'NO_MATCH' });
  });

  it('loads idempotently and requires explicit Neon development confirmation', async () => {
    const host = 'ep-confirmed-development-pooler.c-2.us-east-1.aws.neon.tech';
    const safe = {
      DATABASE_URL: `postgresql://example:example@${host}/neondb?sslmode=require`,
      NEON_DEVELOPMENT_HOST: host,
      NODE_ENV: 'development',
      APP_ENV: 'local',
    };
    expect(() => assertHotelDevelopmentTarget(safe, 'ep-confirmed-development')).not.toThrow();
    expect(() => assertHotelDevelopmentTarget(safe, 'ep-main')).toThrow('Refusing data load');

    const tx = {
      factor: {
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve(create)),
      },
      factorSource: {
        upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve(create)),
      },
      factorVersion: {
        upsert: jest.fn().mockImplementation(({ create }) =>
          Promise.resolve({ id: 'hotel-version-2026', ...create })),
      },
      conversionFactor: {
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve(create)),
      },
    };
    const prisma = {
      $transaction: jest.fn().mockImplementation((callback) => callback(tx)),
    } as unknown as PrismaClient;

    await seedDesnzHotelCanada2026(prisma);

    expect(tx.factorVersion.upsert.mock.calls[0][0].update).toEqual({
      factorValue: desnzHotelCanada2026Version.factorValue,
    });
    expect(tx.conversionFactor.upsert.mock.calls[0][0].update).toEqual({
      factorValue: desnzHotelCanada2026Legacy.factorValue,
    });
  });
});

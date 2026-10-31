import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Prisma, UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.service';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { ConversionFactorsController } from './conversion-factors.controller';
import { ConversionFactorsService } from './conversion-factors.service';
import { FactorSourcesController } from './factor-sources.controller';
import { FactorVersionsController } from './factor-versions.controller';
import { FactorsController } from './factors.controller';

const approvedGovernance = {
  applicability: 'CORPORATE_INVENTORY',
  emissionBasis: 'DIRECT_CO2E',
  verified: true,
  verificationStatus: 'VERIFIED',
  resultUnit: 'kgCO2e',
  isSystemDefault: true,
  isDefault: true,
};

function factor(overrides: Record<string, unknown>) {
  return {
    id: `internal-${String(overrides.name ?? 'factor')}`,
    organizationId: null,
    name: 'Approved factor',
    type: 'EMISSION',
    activityType: 'DIESEL',
    country: 'Canada',
    region: 'Canada',
    jurisdiction: 'Canada',
    unit: 'L',
    factorValue: new Prisma.Decimal(1),
    sourceName: 'Published source',
    sourceAuthority: 'Published source',
    sourceDocument: 'Published methodology',
    sourceReference: null,
    sourceUrl: 'https://example.com/methodology',
    sourceYear: 2026,
    effectiveFrom: null,
    effectiveTo: null,
    methodology: 'Approved calculation methodology.',
    confidenceLevel: 'OFFICIAL_GOVERNMENT',
    notes: 'Approved assumption.',
    methodologyProvenance: { factorYear: 2026 },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...approvedGovernance,
    ...overrides,
  };
}

describe('customer factor catalog separation', () => {
  const approved = [
    factor({ name: 'Motor gasoline combustion - Canada - 2026', activityType: 'GASOLINE', unit: 'L' }),
    factor({ name: 'Diesel combustion - Canada - 2026', activityType: 'DIESEL', unit: 'L' }),
    factor({ name: 'Natural gas combustion - Alberta - 2026', activityType: 'NATURAL_GAS', jurisdiction: 'Alberta, Canada', region: 'Alberta', unit: 'GJ' }),
    factor({ name: 'Natural gas combustion - Alberta - 2026 - volume', activityType: 'NATURAL_GAS', jurisdiction: 'Alberta, Canada', region: 'Alberta', unit: 'm3' }),
    factor({ name: 'Hotel stay - Canada - 2026', activityType: 'HOTEL', unit: 'room-night' }),
    ...(['SHORT', 'MEDIUM', 'LONG'] as const).map((haulCategory) => factor({
      name: `Internal air ${haulCategory}`,
      activityType: 'AIR_TRAVEL',
      unit: 'passenger-km',
      sourceAuthority: 'U.S. Environmental Protection Agency',
      sourceName: 'EPA',
      sourceYear: 2025,
      methodologyProvenance: { factorYear: 2025, haulCategory },
    })),
    factor({
      name: 'Electricity - Alberta - 2026 Location-based',
      activityType: 'ELECTRICITY',
      jurisdiction: 'Alberta, Canada',
      region: 'Alberta',
      unit: 'kWh',
      methodologyProvenance: { factorYear: 2026, scope2AccountingMethod: 'LOCATION_BASED' },
    }),
  ];
  const excluded = [
    factor({ name: 'Legacy Alberta 0.53', verified: false }),
    factor({ name: 'EGDF ordinary Scope 2', applicability: 'REFERENCE_ONLY' }),
    factor({ name: 'Legacy hotel', verificationStatus: 'DRAFT' }),
    factor({ name: 'Legacy generic air travel', verified: false }),
    factor({ name: 'Demo factor', applicability: null, verified: false }),
  ];

  function service() {
    const prisma = {
      conversionFactor: {
        findMany: jest.fn().mockResolvedValue([...approved, ...excluded]),
        findFirst: jest.fn(),
      },
    } as never;
    return new ConversionFactorsService(prisma, { log: jest.fn() } as never, { track: jest.fn() } as never);
  }

  it('returns only approved customer-safe methodology fields with distinct factor labels', async () => {
    const result = await service().findCustomerMethodology();
    const serialized = JSON.stringify(result);

    expect(result.items.map((item) => item.displayName)).toEqual(expect.arrayContaining([
      'Air travel — Short haul — EPA 2025',
      'Air travel — Medium haul — EPA 2025',
      'Air travel — Long haul — EPA 2025',
      'Natural gas combustion - Alberta - 2026 — GJ',
      'Natural gas combustion - Alberta - 2026 - volume — m3',
    ]));
    expect(result.items.find((item) => item.activityType === 'ELECTRICITY')).toMatchObject({
      accountingBasis: 'Scope 2 — Location-based',
      status: 'Approved',
    });
    for (const hidden of ['Legacy Alberta 0.53', 'EGDF ordinary Scope 2', 'Legacy hotel', 'Legacy generic air travel', 'Demo factor']) {
      expect(serialized).not.toContain(hidden);
    }
    for (const internalField of ['internal-', 'factorId', 'factorVersionId', 'verificationStatus', 'confidenceLevel']) {
      expect(serialized).not.toContain(internalField);
    }
  });

  it('filters direct customer conversion-factor enumeration through canonical eligibility', async () => {
    const result = await service().findAllCustomerEligible('customer-org', { page: 1, pageSize: 100 });
    expect(result.items).toHaveLength(approved.length);
    expect(result.items.every((item) => item.verified && item.applicability === 'CORPORATE_INVENTORY')).toBe(true);
    expect(result.items.map((item) => item.name)).not.toEqual(expect.arrayContaining(excluded.map((item) => item.name)));
  });

  it('uses the safe catalog for customer admins and the full catalog for platform admins', async () => {
    const conversionFactors = {
      findAll: jest.fn().mockResolvedValue({ items: ['full'] }),
      findAllCustomerEligible: jest.fn().mockResolvedValue({ items: ['safe'] }),
    } as never;
    const controller = new ConversionFactorsController(conversionFactors);
    const customerAdmin: AuthenticatedUser = {
      id: 'customer-admin', email: 'customer@example.com', organizationId: 'customer-org',
      organizationName: 'Customer', role: UserRole.ADMIN, platformRole: UserRole.USER,
      membershipRole: 'ADMIN', accountType: 'CUSTOMER',
    };
    const platformAdmin = { ...customerAdmin, id: 'platform-admin', platformRole: UserRole.ADMIN };

    await expect(controller.findAll(customerAdmin, {})).resolves.toEqual({ items: ['safe'] });
    await expect(controller.findAll(platformAdmin, {})).resolves.toEqual({ items: ['full'] });
  });

  it.each([FactorsController, FactorSourcesController, FactorVersionsController])(
    'platform-guards the internal %p catalog',
    (controller) => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[];
      expect(guards).toContain(PlatformAdminGuard);
    },
  );
});

import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { assertSafeTestDatabaseTarget } from './database-safety';

/** Test inputs only, never source approval evidence. Uses the same legacy
 * governance fields as seedReviewedFactors; no invented lifecycle column. */
export function governedFactor(overrides: Partial<Prisma.ConversionFactorUncheckedCreateInput> = {}): Prisma.ConversionFactorUncheckedCreateInput {
  return {
    name: 'E2E-reviewed combustion factor', type: 'EMISSION', activityType: 'DIESEL',
    unit: 'liters', factorValue: 2.68, resultUnit: 'kgCO2e',
    country: 'Canada', region: 'Alberta', jurisdiction: 'Alberta, Canada',
    sourceYear: 2026, sourceAuthority: 'CarbonLite E2E Review',
    sourceDocument: 'E2E Reviewed Calculation Inputs 2026',
    methodology: 'Deterministic E2E calculation inputs; not production source evidence.',
    verified: true, verificationStatus: 'VERIFIED', confidenceLevel: 'HIGH',
    applicability: 'CORPORATE_INVENTORY', emissionBasis: 'DIRECT_CO2E',
    methodologyProvenance: { sourceVersion: 'E2E_REVIEWED_2026', sectorApplicability: [] },
    ...overrides,
  };
}

export async function createGovernedFactor(prisma: PrismaService, overrides: Partial<Prisma.ConversionFactorUncheckedCreateInput> = {}) {
  assertSafeTestDatabaseTarget();
  return prisma.conversionFactor.create({ data: governedFactor(overrides) });
}

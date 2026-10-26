import { INestApplication } from '@nestjs/common';
import { Organization, User } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';

export type TestUser = {
  accessToken: string;
  user: {
    id: string;
    email: string;
    organizationId: string;
    organizationName: string;
    role: 'ADMIN' | 'USER';
  };
  password: string;
};

export function uniqueTestId(prefix = 'carbonlite-e2e') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createTestOrganization(
  prisma: PrismaService,
  name = uniqueTestId('CarbonLite E2E Org'),
): Promise<Organization> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  return prisma.organization.create({
    data: {
      name,
      slug,
    },
  });
}

export async function createTestUser(
  app: INestApplication,
  options: {
    organizationName?: string;
    email?: string;
    password?: string;
    factorProfile?: 'reviewed';
  } = {},
): Promise<TestUser> {
  const password = options.password ?? 'Fictional-Test-Only!2026';
  const email =
    options.email ?? `${uniqueTestId('user')}@carbonlite-e2e.test`;
  const organizationName =
    options.organizationName ?? uniqueTestId('CarbonLite E2E Org');

  const response = await request(app.getHttpServer())
    .post('/api/auth/register')
    .send({ organizationName, email, password })
    .expect(201);

  if (options.factorProfile === 'reviewed') {
    await seedReviewedFactors(
      app.get(PrismaService),
      response.body.user.organizationId,
    );
  }

  return {
    accessToken: response.body.accessToken,
    user: response.body.user,
    password,
  };
}

const reviewedFactorDefinitions = [
  { activityType: 'DIESEL', name: 'E2E-reviewed diesel combustion factor', unit: 'liters', factorValue: 2.68, jurisdiction: 'Canada' },
  { activityType: 'GASOLINE', name: 'E2E-reviewed gasoline combustion factor', unit: 'liters', factorValue: 2.31, jurisdiction: 'Canada' },
  { activityType: 'NATURAL_GAS', name: 'E2E-reviewed natural gas combustion factor', unit: 'm3', factorValue: 1.89, jurisdiction: 'Canada' },
  { activityType: 'ELECTRICITY', name: 'E2E-reviewed Alberta electricity factor', unit: 'kWh', factorValue: 0.53, jurisdiction: 'Alberta' },
  { activityType: 'AIR_TRAVEL', name: 'E2E-reviewed air travel factor', unit: 'km', factorValue: 0.115, jurisdiction: 'Canada' },
  { activityType: 'HOTEL', name: 'E2E-reviewed hotel stay factor', unit: 'nights', factorValue: 15, jurisdiction: 'Canada' },
  { activityType: 'GROUND_TRANSPORT', name: 'E2E-reviewed ground transport factor', unit: 'km', factorValue: 0.2, jurisdiction: 'Canada' },
  { activityType: 'SHIPPING', name: 'E2E-reviewed shipping factor', unit: 'ton-km', factorValue: 0.09, jurisdiction: 'Canada' },
] as const;

/**
 * Deterministic E2E factors for ordinary customer workspaces. These are
 * tenant-owned, verified records; they neither enable demo factors nor bypass
 * the production workspace/methodology predicates.
 */
export async function seedReviewedFactors(
  prisma: PrismaService,
  organizationId: string,
) {
  await prisma.conversionFactor.createMany({
    data: reviewedFactorDefinitions.map((factor) => ({
      id: `reviewed-${organizationId}-${factor.activityType.toLowerCase()}`,
      organizationId,
      name: factor.name,
      type: 'EMISSION' as const,
      activityType: factor.activityType,
      jurisdiction: factor.jurisdiction,
      region: factor.jurisdiction,
      country: 'Canada',
      unit: factor.unit,
      factorValue: factor.factorValue,
      resultUnit: 'kgCO2e',
      sourceName: 'CarbonLite E2E Review',
      sourceReference: 'E2E Reviewed Calculation Inputs 2026',
      sourceAuthority: 'CarbonLite E2E Review',
      sourceDocument: 'E2E Reviewed Calculation Inputs 2026',
      sourceYear: 2025,
      methodology: 'Value approved solely for deterministic E2E calculation assertions.',
      confidenceLevel: 'HIGH',
      verificationStatus: 'VERIFIED',
      verified: true,
      notes: 'Scoped to the tenant created by this E2E scenario; not production factor evidence.',
      isDefault: true,
      isSystemDefault: true,
      applicability: 'CORPORATE_INVENTORY' as const,
      emissionBasis: 'DIRECT_CO2E' as const,
      methodologyProvenance: {
        sourceVersion: 'E2E_REVIEWED_2026',
        reviewStatus: 'APPROVED',
        purpose: 'DETERMINISTIC_E2E',
      },
    })),
    skipDuplicates: true,
  });
}

export async function loginAndGetToken(
  app: INestApplication,
  email: string,
  password: string,
): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ email, password })
    .expect(201);

  return response.body.accessToken;
}

export async function cleanupTestData(
  prisma: PrismaService,
  testRunId: string,
) {
  // Deleting organizations cascades to users and tenant-owned records.
  await prisma.organization.deleteMany({
    where: {
      name: {
        contains: testRunId,
      },
    },
  });

  await prisma.user.deleteMany({
    where: {
      email: {
        contains: testRunId,
      },
    },
  });
}

export function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export type TestOrganization = Organization;
export type TestUserModel = User;

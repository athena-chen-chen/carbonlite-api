import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import {
  authHeader,
  cleanupTestData,
  createTestUser,
  uniqueTestId,
} from './helpers/factories';

describe('ActivityData list factor snapshot fields (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('activity-list-snapshot');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('returns paginated old and new activity records without crashing on null snapshot metadata', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Org`,
      email: `user-${testRunId}@carbonlite-e2e.test`,
    });

    const legacyRecord = await prisma.activityData.create({
      data: {
        organizationId: user.user.organizationId,
        activityType: 'DIESEL',
        recordDate: new Date('2026-07-21T00:00:00.000Z'),
        quantity: new Prisma.Decimal('10'),
        unit: 'L',
        sourceType: 'MANUAL',
        sourceReference: testRunId,
      },
    });

    const newRecord = await prisma.activityData.create({
      data: {
        organizationId: user.user.organizationId,
        activityType: 'GROUND_TRANSPORT',
        recordDate: new Date('2026-07-22T00:00:00.000Z'),
        quantity: new Prisma.Decimal('100'),
        unit: 'km',
        jurisdictionCountry: 'Canada',
        sourceType: 'MANUAL',
        sourceReference: testRunId,
        matchingStatus: 'MATCHED',
        reportTreatment: 'INCLUDED',
        scope: 'SCOPE_3',
        matchedFactorId: 'pilot-ground-transport-canada-2025',
        matchedFactorName: 'Ground Transport - Canada - 2025',
        matchedFactorSourceYear: 2025,
        matchedFactorValue: 0.2,
        matchedFactorUnit: 'kgCO2e/km',
        matchedFactorVersion: 'v1.0',
        matchedFactorSourceAuthority: 'CarbonLite',
        matchedFactorSourceDocument: 'CarbonLite Pilot Ground Transport Estimate 2025',
        matchedFactorVerificationStatus: 'Internal Review Required',
        matchedFactorConfidenceLevel: 'Pilot Estimate',
        matchedFactorAssumptions: 'Pilot estimate for ground transport distance-based calculation.',
        calculatedEmissionsKgCO2e: 20,
        calculationStatus: 'CALCULATED',
        calculationMessage: 'Matched factor. Using latest available factor year: 2025.',
      },
    });

    const response = await request(app.getHttpServer())
      .get('/api/activity-data?page=1&pageSize=100')
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(response.body).toMatchObject({
      page: 1,
      pageSize: 100,
      total: 2,
      totalPages: 1,
    });

    const items = response.body.items as Array<Record<string, unknown>>;
    const listedLegacyRecord = items.find((item) => item.id === legacyRecord.id);
    const listedNewRecord = items.find((item) => item.id === newRecord.id);

    expect(listedLegacyRecord).toMatchObject({
      id: legacyRecord.id,
      matchedFactorId: null,
      matchedFactorValue: null,
      matchedFactorSourceAuthority: null,
      matchedFactorAssumptions: null,
    });
    expect(listedNewRecord).toMatchObject({
      id: newRecord.id,
      matchedFactorId: 'pilot-ground-transport-canada-2025',
      matchedFactorName: 'Ground Transport - Canada - 2025',
      matchedFactorValue: 0.2,
      matchedFactorUnit: 'kgCO2e/km',
      matchedFactorSourceAuthority: 'CarbonLite',
      matchedFactorSourceDocument: 'CarbonLite Pilot Ground Transport Estimate 2025',
      matchedFactorVerificationStatus: 'Internal Review Required',
      matchedFactorConfidenceLevel: 'Pilot Estimate',
      matchedFactorAssumptions: 'Pilot estimate for ground transport distance-based calculation.',
      calculatedEmissionsKgCO2e: 20,
    });
  });
});

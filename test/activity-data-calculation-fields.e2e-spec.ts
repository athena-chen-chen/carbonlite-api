import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import {
  authHeader,
  cleanupTestData,
  createTestUser,
  uniqueTestId,
} from './helpers/factories';

describe('ActivityData canonical calculation fields (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('activity-calc-fields');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('POST /api/activity-data persists and returns canonical calculation fields', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Org`,
      email: `user-${testRunId}@carbonlite-e2e.test`,
    });

    const response = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(user.accessToken))
      .send({
        activityType: 'ELECTRICITY',
        recordDate: '2026-07-20',
        quantity: 12500,
        unit: 'kWh',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        recordYear: 2026,
        sourceType: 'MANUAL',
        sourceReference: 'manual',
        dateEstimated: false,
        matchingStatus: 'MATCHED',
        reportTreatment: 'INCLUDED',
        scope: 'SCOPE_2',
        matchedFactorId: 'cmr75gv6l0007gdjbs0bz4d3j',
        matchedFactorName: 'Electricity - Alberta',
        matchedFactorSourceYear: 2025,
        calculatedEmissionsKgCO2e: 6625,
        calculationStatus: 'CALCULATED',
        calculationMessage: 'Matched factor. Using latest available factor year: 2025.',
      })
      .expect(201);

    expect(response.body).toMatchObject({
      matchingStatus: 'MATCHED',
      reportTreatment: 'INCLUDED',
      scope: 'SCOPE_2',
      matchedFactorId: 'cmr75gv6l0007gdjbs0bz4d3j',
      matchedFactorName: 'Electricity - Alberta',
      matchedFactorSourceYear: 2025,
      calculatedEmissionsKgCO2e: 6625,
      calculationStatus: 'CALCULATED',
      calculationMessage: 'Matched factor. Using latest available factor year: 2025.',
    });
    expect(String(response.body.recordDate).slice(0, 10)).toBe('2026-07-20');
  });

  it('POST /api/activity-data saves Ground Transport without province and stores pilot factor id as a string', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Ground Transport Org`,
      email: `ground-transport-${testRunId}@carbonlite-e2e.test`,
    });

    const response = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(user.accessToken))
      .send({
        activityType: 'GROUND_TRANSPORT',
        recordDate: '2026-07-22',
        quantity: 100,
        unit: 'km',
        jurisdictionCountry: 'Canada',
        recordYear: 2026,
        sourceType: 'MANUAL',
        sourceReference: 'manual',
        notes:
          'Calculation status: Matched. Using latest available factor year: 2025. Matched factor: Ground Transport - Canada - 2025 (0.2). Calculated emissions: 20 kgCO2e.',
        dateEstimated: false,
        matchingStatus: 'MATCHED',
        reportTreatment: 'INCLUDED',
        scope: 'SCOPE_3',
        matchedFactorId: 'pilot-ground-transport-canada-2025',
        matchedFactorName: 'Ground Transport - Canada - 2025',
        matchedFactorSourceYear: 2025,
        calculatedEmissionsKgCO2e: 20,
        calculationStatus: 'CALCULATED',
        calculationMessage: 'Matched factor. Using latest available factor year: 2025.',
      })
      .expect(201);

    expect(response.body).toMatchObject({
      activityType: 'GROUND_TRANSPORT',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: null,
      matchingStatus: 'MATCHED',
      reportTreatment: 'INCLUDED',
      scope: 'SCOPE_3',
      matchedFactorId: 'pilot-ground-transport-canada-2025',
      matchedFactorName: 'Ground Transport - Canada - 2025',
      matchedFactorSourceYear: 2025,
      calculatedEmissionsKgCO2e: 20,
      calculationStatus: 'CALCULATED',
      calculationMessage: 'Matched factor. Using latest available factor year: 2025.',
    });
    expect(String(response.body.recordDate).slice(0, 10)).toBe('2026-07-22');
  });
});

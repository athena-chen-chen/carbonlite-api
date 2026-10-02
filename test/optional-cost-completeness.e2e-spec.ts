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

describe('Optional cost completeness (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('optional-cost');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('persists Cost CAD and counts tracked-only rows in optional cost completeness', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Org`,
      email: `user-${testRunId}@carbonlite-e2e.test`,
    });
    const auth = authHeader(user.accessToken);

    const records = [
      {
        activityType: 'ELECTRICITY',
        recordDate: '2026-03-01',
        quantity: 980,
        unit: 'kWh',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        sourceType: 'IMPORT',
        sourceReference: 'MARCH-ELEC-001',
        costCad: 214.55,
        costCurrency: 'CAD',
      },
      {
        activityType: 'WATER',
        recordDate: '2026-03-07',
        quantity: 18,
        unit: 'm3',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        sourceType: 'IMPORT',
        sourceReference: 'MARCH-WATER-007',
        costCad: 64,
        costCurrency: 'CAD',
      },
      {
        activityType: 'HOTEL',
        recordDate: '2026-03-10',
        quantity: 4,
        unit: 'nights',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Ontario',
        sourceType: 'IMPORT',
        sourceReference: 'MARCH-HOTEL-010',
        costCad: 720,
        costCurrency: 'CAD',
      },
    ];

    for (const record of records) {
      await request(app.getHttpServer())
        .post('/api/activity-data')
        .set(auth)
        .send(record)
        .expect(201);
    }

    const activityData = await request(app.getHttpServer())
      .get('/api/activity-data?page=1&pageSize=100&search=MARCH')
      .set(auth)
      .expect(200);

    expect(activityData.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceReference: 'MARCH-ELEC-001',
          costCad: '214.55',
          costCurrency: 'CAD',
        }),
        expect.objectContaining({
          sourceReference: 'MARCH-WATER-007',
          costCad: '64',
          costCurrency: 'CAD',
        }),
        expect.objectContaining({
          sourceReference: 'MARCH-HOTEL-010',
          costCad: '720',
          costCurrency: 'CAD',
        }),
      ]),
    );

    const summary = await request(app.getHttpServer())
      .get('/api/metrics/summary')
      .set(auth)
      .expect(200);

    expect(summary.body.dataQualitySummary).toMatchObject({
      totalRecords: 3,
      costDataCoverage: 100,
      trackedOnlyCount: 1,
    });
    expect(summary.body.dataQualitySummary.checklist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'cost-data',
          count: 3,
          total: 3,
        }),
      ]),
    );
    expect(summary.body.calculationDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceReference: 'MARCH-WATER-007',
          status: 'TRACKED_ONLY',
          costCad: 64,
          costCurrency: 'CAD',
        }),
      ]),
    );
  });
});

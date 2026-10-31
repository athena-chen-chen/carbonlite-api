import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { seedDesnzHotelCanada2026 } from '../prisma/library/desnz-hotel-canada-2026';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import { authHeader, cleanupTestData, createTestUser, uniqueTestId } from './helpers/factories';

describe('Hotel room-night aggregate (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('hotel-room-night');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
    await seedDesnzHotelCanada2026(prisma);
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('persists direct and derived room-night records and includes each once', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Org`,
      email: `${testRunId}@carbonlite-e2e.test`,
    });
    const auth = authHeader(user.accessToken);
    const base = {
      activityType: 'HOTEL',
      recordDate: '2026-06-30',
      sourceType: 'MANUAL',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Alberta',
      sourceReference: testRunId,
    };

    const direct = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(auth)
      .send({ ...base, quantity: 3, unit: 'room-night' })
      .expect(201);
    const derived = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(auth)
      .send({ ...base, quantity: 3, unit: 'nights', rooms: 2, nights: 3 })
      .expect(201);

    expect(direct.body).toMatchObject({
      unit: 'room-night',
      calculationStatus: 'CALCULATED',
      matchedFactorValue: 7.4,
      calculatedEmissionsKgCO2e: 22.2,
    });
    expect(Number(derived.body.quantity)).toBe(6);
    expect(derived.body).toMatchObject({
      unit: 'room-night',
      calculationStatus: 'CALCULATED',
      matchedFactorValue: 7.4,
      calculatedEmissionsKgCO2e: 44.4,
    });

    const summary = await request(app.getHttpServer())
      .get('/api/metrics/calculation-summary')
      .set(auth)
      .expect(200);
    const hotelDetails = summary.body.calculationDetails.filter(
      (detail: { activityType: string }) => detail.activityType === 'HOTEL',
    );
    expect(hotelDetails).toHaveLength(2);
    expect(summary.body.totalEstimatedEmissionsKgCO2e).toBeCloseTo(66.6, 10);
  });
});

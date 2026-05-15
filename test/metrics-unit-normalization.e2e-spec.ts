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

describe('Metrics unit normalization (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('unit-normalization');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('matches singular activity unit "night" to system factor unit "nights"', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Hotel Org`,
      email: `hotel-${testRunId}@carbonlite-e2e.test`,
    });
    const auth = authHeader(user.accessToken);

    const factors = await request(app.getHttpServer())
      .get('/api/conversion-factors?activityType=HOTEL')
      .set(auth)
      .expect(200);
    const hotelSystemFactor = factors.body.items.find(
      (factor: { isSystemDefault: boolean; unit: string }) =>
        factor.isSystemDefault && factor.unit === 'nights',
    );

    const activity = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(auth)
      .send({
        activityType: 'HOTEL',
        recordDate: '2026-01-01',
        quantity: 2,
        unit: 'night',
        sourceType: 'MANUAL',
        sourceReference: testRunId,
      })
      .expect(201);

    const metrics = await request(app.getHttpServer())
      .post('/api/metrics/calculate')
      .set(auth)
      .send({
        activityDataIds: [activity.body.id],
        metricTypes: ['CARBON_EMISSION'],
      })
      .expect(201);

    expect(metrics.body.items[0]).toMatchObject({
      factorId: hotelSystemFactor.id,
      value: '30',
      unit: 'kgCO2e',
    });
  });

  it('matches liter/litre variants and prefers organization custom factors', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Fuel Org`,
      email: `fuel-${testRunId}@carbonlite-e2e.test`,
    });
    const auth = authHeader(user.accessToken);

    const customFactor = await request(app.getHttpServer())
      .post('/api/conversion-factors')
      .set(auth)
      .send({
        name: `${testRunId} Custom litre diesel factor`,
        type: 'EMISSION',
        activityType: 'DIESEL',
        unit: 'litres',
        factorValue: 7,
        resultUnit: 'kgCO2e',
      })
      .expect(201);

    const activity = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(auth)
      .send({
        activityType: 'DIESEL',
        recordDate: '2026-01-01',
        quantity: 3,
        unit: 'liter',
        sourceType: 'MANUAL',
        sourceReference: testRunId,
      })
      .expect(201);

    const metrics = await request(app.getHttpServer())
      .post('/api/metrics/calculate')
      .set(auth)
      .send({
        activityDataIds: [activity.body.id],
        metricTypes: ['CARBON_EMISSION'],
      })
      .expect(201);

    expect(metrics.body.items[0]).toMatchObject({
      factorId: customFactor.body.id,
      value: '21',
      unit: 'kgCO2e',
    });
  });

  it('matches km/kilometer variants and kWh casing', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Travel Power Org`,
      email: `travel-power-${testRunId}@carbonlite-e2e.test`,
    });
    const auth = authHeader(user.accessToken);

    const factorResponse = await request(app.getHttpServer())
      .get('/api/conversion-factors')
      .set(auth)
      .expect(200);
    const airTravelFactor = factorResponse.body.items.find(
      (factor: { activityType: string; isSystemDefault: boolean }) =>
        factor.isSystemDefault && factor.activityType === 'AIR_TRAVEL',
    );
    const electricityFactor = factorResponse.body.items.find(
      (factor: { activityType: string; isSystemDefault: boolean }) =>
        factor.isSystemDefault && factor.activityType === 'ELECTRICITY',
    );

    const airTravel = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(auth)
      .send({
        activityType: 'AIR_TRAVEL',
        recordDate: '2026-01-01',
        quantity: 10,
        unit: 'kilometers',
        sourceType: 'MANUAL',
        sourceReference: testRunId,
      })
      .expect(201);
    const electricity = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(auth)
      .send({
        activityType: 'ELECTRICITY',
        recordDate: '2026-01-01',
        quantity: 2,
        unit: 'kwh',
        sourceType: 'MANUAL',
        sourceReference: testRunId,
      })
      .expect(201);

    const metrics = await request(app.getHttpServer())
      .post('/api/metrics/calculate')
      .set(auth)
      .send({
        activityDataIds: [airTravel.body.id, electricity.body.id],
        metricTypes: ['CARBON_EMISSION'],
      })
      .expect(201);

    expect(metrics.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activityDataId: airTravel.body.id,
          factorId: airTravelFactor.id,
          value: '1.15',
        }),
        expect.objectContaining({
          activityDataId: electricity.body.id,
          factorId: electricityFactor.id,
          value: '1.06',
        }),
      ]),
    );
  });
});

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

describe('System and custom conversion factors (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('system-factors');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('shows system defaults to a new user and blocks editing/deleting them', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} New Org`,
      email: `new-user-${testRunId}@carbonlite-e2e.test`,
    });
    const auth = authHeader(user.accessToken);

    const response = await request(app.getHttpServer())
      .get('/api/conversion-factors')
      .set(auth)
      .expect(200);

    const systemDefaults = response.body.items.filter(
      (item: { isSystemDefault: boolean }) => item.isSystemDefault,
    );

    expect(systemDefaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activityType: 'DIESEL',
          unit: 'liters',
          factorValue: expect.any(String),
          resultUnit: 'kgCO2e',
          isSystemDefault: true,
        }),
        expect.objectContaining({
          activityType: 'AIR_TRAVEL',
          unit: 'km',
          resultUnit: 'kgCO2e',
          isSystemDefault: true,
        }),
      ]),
    );

    const dieselSystem = systemDefaults.find(
      (item: { activityType: string; unit: string }) =>
        item.activityType === 'DIESEL' && item.unit === 'liters',
    );

    await request(app.getHttpServer())
      .patch(`/api/conversion-factors/${dieselSystem.id}`)
      .set(auth)
      .send({ factorValue: 9.99 })
      .expect(403);

    await request(app.getHttpServer())
      .delete(`/api/conversion-factors/${dieselSystem.id}`)
      .set(auth)
      .expect(403);
  });

  it('lets users create custom factors without leaking them to other organizations', async () => {
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} Org A`,
      email: `user-a-${testRunId}@carbonlite-e2e.test`,
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} Org B`,
      email: `user-b-${testRunId}@carbonlite-e2e.test`,
    });
    const authA = authHeader(userA.accessToken);
    const authB = authHeader(userB.accessToken);

    const customB = await request(app.getHttpServer())
      .post('/api/conversion-factors')
      .set(authB)
      .send({
        name: `${testRunId} Org B custom diesel factor`,
        type: 'EMISSION',
        activityType: 'DIESEL',
        unit: 'liters',
        factorValue: 4.44,
        resultUnit: 'kgCO2e',
      })
      .expect(201);

    expect(customB.body.organizationId).toBe(userB.user.organizationId);
    expect(customB.body.isSystemDefault).toBe(false);

    const listA = await request(app.getHttpServer())
      .get('/api/conversion-factors')
      .set(authA)
      .expect(200);

    expect(
      listA.body.items.map((item: { id: string }) => item.id),
    ).not.toContain(customB.body.id);
    expect(
      listA.body.items.some(
        (item: { isSystemDefault: boolean }) => item.isSystemDefault,
      ),
    ).toBe(true);
  });

  it('prefers an organization custom factor over a matching system default', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Matching Org`,
      email: `matching-${testRunId}@carbonlite-e2e.test`,
    });
    const auth = authHeader(user.accessToken);

    const customFactor = await request(app.getHttpServer())
      .post('/api/conversion-factors')
      .set(auth)
      .send({
        name: `${testRunId} Preferred custom diesel factor`,
        type: 'EMISSION',
        activityType: 'DIESEL',
        unit: 'liters',
        factorValue: 9.99,
        resultUnit: 'kgCO2e',
      })
      .expect(201);

    const activity = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(auth)
      .send({
        activityType: 'DIESEL',
        recordDate: '2026-01-01',
        quantity: 10,
        unit: 'liters',
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
      value: '99.9',
      unit: 'kgCO2e',
    });
  });
});

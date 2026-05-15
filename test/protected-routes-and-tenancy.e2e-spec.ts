import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import {
  authHeader,
  cleanupTestData,
  createTestUser,
  loginAndGetToken,
  uniqueTestId,
} from './helpers/factories';

describe('Protected routes and tenant isolation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('tenant');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('requires JWT auth for protected modules', async () => {
    await request(app.getHttpServer()).get('/api/documents').expect(401);
    await request(app.getHttpServer()).get('/api/activity-data').expect(401);
    await request(app.getHttpServer()).get('/api/metrics').expect(401);
    await request(app.getHttpServer()).get('/api/reports').expect(401);
    await request(app.getHttpServer()).get('/api/conversion-factors').expect(401);
    await request(app.getHttpServer())
      .post('/api/document-extraction/extract')
      .send({ documentId: 'missing' })
      .expect(401);
  });

  it('keeps documents, activity data, reports, metrics, and conversion factors tenant-scoped', async () => {
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} Org A`,
      email: `user-a-${testRunId}@carbonlite-e2e.test`,
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} Org B`,
      email: `user-b-${testRunId}@carbonlite-e2e.test`,
      password: 'password123',
    });

    const authA = authHeader(userA.accessToken);
    const userBLoginToken = await loginAndGetToken(
      app,
      userB.user.email,
      'password123',
    );
    const authB = authHeader(userBLoginToken);

    const documentA = await request(app.getHttpServer())
      .post('/api/documents/upload')
      .set(authA)
      .field('type', 'OTHER')
      .attach('file', Buffer.from('date,quantity,unit\n2026-01-01,10,kWh\n'), {
        filename: `${testRunId}-document-a.csv`,
        contentType: 'text/csv',
      })
      .expect(201);

    const activityA = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authA)
      .send({
        activityType: 'DIESEL',
        recordDate: '2026-01-01',
        quantity: 10,
        unit: 'liters',
        sourceType: 'MANUAL',
        sourceReference: testRunId,
      })
      .expect(201);

    const reportA = await request(app.getHttpServer())
      .post('/api/reports')
      .set(authA)
      .send({
        title: `${testRunId} Report A`,
        reportingYear: 2026,
      })
      .expect(201);

    const factorA = await request(app.getHttpServer())
      .post('/api/conversion-factors')
      .set(authA)
      .send({
        name: `${testRunId} Diesel emission factor`,
        type: 'EMISSION',
        activityType: 'DIESEL',
        unit: 'liters',
        factorValue: 2.68,
        resultUnit: 'kgCO2e',
        isDefault: true,
      })
      .expect(201);

    const metricsA = await request(app.getHttpServer())
      .post('/api/metrics/calculate')
      .set(authA)
      .send({
        activityDataIds: [activityA.body.id],
        metricTypes: ['CARBON_EMISSION'],
      })
      .expect(201);

    const documentListB = await request(app.getHttpServer())
      .get('/api/documents')
      .set(authB)
      .expect(200);
    expect(
      documentListB.body.items.map((item: { id: string }) => item.id),
    ).not.toContain(documentA.body.id);

    const activityListB = await request(app.getHttpServer())
      .get('/api/activity-data')
      .set(authB)
      .expect(200);
    expect(
      activityListB.body.items.map((item: { id: string }) => item.id),
    ).not.toContain(activityA.body.id);

    await request(app.getHttpServer())
      .get(`/api/activity-data/${activityA.body.id}`)
      .set(authB)
      .expect(404);

    const reportListB = await request(app.getHttpServer())
      .get('/api/reports')
      .set(authB)
      .expect(200);
    expect(
      reportListB.body.items.map((item: { id: string }) => item.id),
    ).not.toContain(reportA.body.id);

    await request(app.getHttpServer())
      .get(`/api/reports/${reportA.body.id}`)
      .set(authB)
      .expect(404);

    const factorListB = await request(app.getHttpServer())
      .get('/api/conversion-factors')
      .set(authB)
      .expect(200);
    expect(
      factorListB.body.items.map((item: { id: string }) => item.id),
    ).not.toContain(factorA.body.id);

    await request(app.getHttpServer())
      .get(`/api/conversion-factors/${factorA.body.id}`)
      .set(authB)
      .expect(404);

    const metricsListB = await request(app.getHttpServer())
      .get('/api/metrics')
      .set(authB)
      .expect(200);
    expect(
      metricsListB.body.items.map((item: { id: string }) => item.id),
    ).not.toContain(metricsA.body.items[0].metricResultId);
  });

  it('allows authenticated access to protected list endpoints', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Protected Org`,
      email: `protected-${testRunId}@carbonlite-e2e.test`,
    });
    const auth = authHeader(user.accessToken);

    await request(app.getHttpServer()).get('/api/documents').set(auth).expect(200);
    await request(app.getHttpServer()).get('/api/activity-data').set(auth).expect(200);
    await request(app.getHttpServer()).get('/api/metrics').set(auth).expect(200);
    await request(app.getHttpServer()).get('/api/reports').set(auth).expect(200);
    await request(app.getHttpServer())
      .get('/api/conversion-factors')
      .set(auth)
      .expect(200);
  });
});

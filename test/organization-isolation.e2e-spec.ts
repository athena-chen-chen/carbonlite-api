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

function expectForbiddenOrNotFound(status: number) {
  expect([403, 404]).toContain(status);
}

function responseItems<T>(body: { items?: T[] } | T[]): T[] {
  return Array.isArray(body) ? body : body.items ?? [];
}

describe('Organization data isolation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('org-isolation');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('isolates tenant data across auth-protected APIs', async () => {
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} Organization A`,
      email: `user-a-${testRunId}@carbonlite-e2e.test`,
      password: 'password123',
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} Organization B`,
      email: `user-b-${testRunId}@carbonlite-e2e.test`,
      password: 'password123',
    });

    expect(userA.user.organizationId).toEqual(expect.any(String));
    expect(userB.user.organizationId).toEqual(expect.any(String));
    expect(userA.user.organizationId).not.toBe(userB.user.organizationId);

    const tokenA = await loginAndGetToken(
      app,
      userA.user.email,
      'password123',
    );
    const tokenB = await loginAndGetToken(
      app,
      userB.user.email,
      'password123',
    );
    const authA = authHeader(tokenA);
    const authB = authHeader(tokenB);

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

    const factorA = await request(app.getHttpServer())
      .post('/api/conversion-factors')
      .set(authA)
      .send({
        name: `${testRunId} Org A diesel factor`,
        type: 'EMISSION',
        activityType: 'DIESEL',
        unit: 'liters',
        factorValue: 2.68,
        resultUnit: 'kgCO2e',
      })
      .expect(201);

    const reportA = await request(app.getHttpServer())
      .post('/api/reports')
      .set(authA)
      .send({
        title: `${testRunId} Org A report`,
        reportingYear: 2026,
      })
      .expect(201);

    const factorB = await request(app.getHttpServer())
      .post('/api/conversion-factors')
      .set(authB)
      .send({
        name: `${testRunId} Org B diesel factor`,
        type: 'EMISSION',
        activityType: 'DIESEL',
        unit: 'liters',
        factorValue: 3.14,
        resultUnit: 'kgCO2e',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/metrics/calculate')
      .set(authA)
      .send({
        activityDataIds: [activityA.body.id],
        metricTypes: ['CARBON_EMISSION'],
      })
      .expect(201);

    const activityListB = await request(app.getHttpServer())
      .get('/api/activity-data')
      .set(authB)
      .expect(200);
    expect(
      responseItems<{ id: string }>(activityListB.body).map((item) => item.id),
    ).not.toContain(activityA.body.id);

    const readActivityAsB = await request(app.getHttpServer())
      .get(`/api/activity-data/${activityA.body.id}`)
      .set(authB);
    expectForbiddenOrNotFound(readActivityAsB.status);

    const updateActivityAsB = await request(app.getHttpServer())
      .patch(`/api/activity-data/${activityA.body.id}`)
      .set(authB)
      .send({ notes: 'cross-tenant update attempt' });
    expectForbiddenOrNotFound(updateActivityAsB.status);

    const deleteActivityAsB = await request(app.getHttpServer())
      .delete(`/api/activity-data/${activityA.body.id}`)
      .set(authB);
    expectForbiddenOrNotFound(deleteActivityAsB.status);

    await request(app.getHttpServer())
      .get(`/api/activity-data/${activityA.body.id}`)
      .set(authA)
      .expect(200);

    const documentListB = await request(app.getHttpServer())
      .get('/api/documents')
      .set(authB)
      .expect(200);
    expect(
      responseItems<{ id: string }>(documentListB.body).map((item) => item.id),
    ).not.toContain(documentA.body.id);

    const extractDocumentAsB = await request(app.getHttpServer())
      .post('/api/document-extraction/extract')
      .set(authB)
      .send({ documentId: documentA.body.id });
    expectForbiddenOrNotFound(extractDocumentAsB.status);

    const importDocumentAsB = await request(app.getHttpServer())
      .post('/api/document-extraction/confirm')
      .set(authB)
      .send({
        documentId: documentA.body.id,
        activities: [
          {
            activityType: 'DIESEL',
            recordDate: '2026-01-01',
            quantity: 1,
            unit: 'liters',
          },
        ],
      });
    expectForbiddenOrNotFound(importDocumentAsB.status);

    const factorListA = await request(app.getHttpServer())
      .get('/api/conversion-factors')
      .set(authA)
      .expect(200);
    const factorIdsA = factorListA.body.items.map(
      (item: { id: string }) => item.id,
    );
    expect(factorIdsA).toContain(factorA.body.id);
    expect(factorIdsA).not.toContain(factorB.body.id);

    const readFactorBAsA = await request(app.getHttpServer())
      .get(`/api/conversion-factors/${factorB.body.id}`)
      .set(authA);
    expectForbiddenOrNotFound(readFactorBAsA.status);

    const summaryA = await request(app.getHttpServer())
      .get('/api/metrics/summary')
      .set(authA)
      .expect(200);
    expect(summaryA.body.totalsByMetric).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metricType: 'CARBON_EMISSION' }),
      ]),
    );

    const summaryB = await request(app.getHttpServer())
      .get('/api/metrics/summary')
      .set(authB)
      .expect(200);
    expect(summaryB.body.totalsByMetric).toEqual([]);
    expect(summaryB.body.totalsByFacility).toEqual([]);

    const reportsA = await request(app.getHttpServer())
      .get('/api/reports')
      .set(authA)
      .expect(200);
    expect(
      responseItems<{ id: string }>(reportsA.body).map((item) => item.id),
    ).toContain(reportA.body.id);

    const reportsB = await request(app.getHttpServer())
      .get('/api/reports')
      .set(authB)
      .expect(200);
    expect(
      responseItems<{ id: string }>(reportsB.body).map((item) => item.id),
    ).not.toContain(reportA.body.id);
  });

  it('returns 401 for missing or invalid tokens', async () => {
    await request(app.getHttpServer()).get('/api/activity-data').expect(401);

    await request(app.getHttpServer())
      .get('/api/activity-data')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401);
  });
});

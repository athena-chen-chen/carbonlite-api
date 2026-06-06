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

describe('Audit Log (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('audit');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('creates audit logs for activity create, update, delete, and bulk delete', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Activity Org`,
      email: `activity-${testRunId}@carbonlite-e2e.test`,
    });

    const createResponse = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(user.accessToken))
      .send(activityPayload({ quantity: 100 }))
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/activity-data/${createResponse.body.id}`)
      .set(authHeader(user.accessToken))
      .send({ quantity: 120 })
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/api/activity-data/${createResponse.body.id}`)
      .set(authHeader(user.accessToken))
      .expect(200);

    const bulkA = await prisma.activityData.create({
      data: activityDataRow(user.user.organizationId, 10),
    });
    const bulkB = await prisma.activityData.create({
      data: activityDataRow(user.user.organizationId, 20),
    });

    await request(app.getHttpServer())
      .post('/api/activity-data/bulk-delete')
      .set(authHeader(user.accessToken))
      .send({ ids: [bulkA.id, bulkB.id] })
      .expect(200);

    await expectAuditActions(user.user.organizationId, [
      'CREATE_ACTIVITY_RECORD',
      'UPDATE_ACTIVITY_RECORD',
      'DELETE_ACTIVITY_RECORD',
      'BULK_DELETE_ACTIVITY_RECORDS',
    ]);

    const updateLog = await prisma.auditLog.findFirst({
      where: {
        organizationId: user.user.organizationId,
        action: 'UPDATE_ACTIVITY_RECORD',
      },
    });
    expect(updateLog?.oldValue).toBeTruthy();
    expect(updateLog?.newValue).toBeTruthy();
  });

  it('creates audit logs for document upload and delete', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Document Org`,
      email: `document-${testRunId}@carbonlite-e2e.test`,
    });

    const uploadResponse = await request(app.getHttpServer())
      .post('/api/documents/upload')
      .set(authHeader(user.accessToken))
      .field('type', 'PDF')
      .attach('file', Buffer.from('sample invoice'), {
        filename: `${testRunId}-invoice.pdf`,
        contentType: 'application/pdf',
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/api/documents/${uploadResponse.body.id}`)
      .set(authHeader(user.accessToken))
      .expect(200);

    await expectAuditActions(user.user.organizationId, [
      'UPLOAD_DOCUMENT',
      'DELETE_DOCUMENT',
    ]);
  });

  it('creates audit logs for conversion factor create and update', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Factor Org`,
      email: `factor-${testRunId}@carbonlite-e2e.test`,
    });

    const createResponse = await request(app.getHttpServer())
      .post('/api/conversion-factors')
      .set(authHeader(user.accessToken))
      .send(factorPayload({ name: `${testRunId} Diesel factor`, factorValue: 2.68 }))
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/conversion-factors/${createResponse.body.id}`)
      .set(authHeader(user.accessToken))
      .send({ factorValue: 2.75 })
      .expect(200);

    await expectAuditActions(user.user.organizationId, [
      'CREATE_CONVERSION_FACTOR',
      'UPDATE_CONVERSION_FACTOR',
    ]);
  });

  it('creates an audit log for report generation', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Report Org`,
      email: `report-${testRunId}@carbonlite-e2e.test`,
    });

    await request(app.getHttpServer())
      .post('/api/reports')
      .set(authHeader(user.accessToken))
      .send({ title: `${testRunId} Emissions Report`, reportingYear: 2026 })
      .expect(201);

    await expectAuditActions(user.user.organizationId, ['GENERATE_REPORT']);
  });

  it('lists newest audit logs and opens details through API', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} List Org`,
      email: `list-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: user.user.id },
      data: { role: 'ADMIN' },
    });
    const log = await prisma.auditLog.create({
      data: {
        organizationId: user.user.organizationId,
        userId: user.user.id,
        action: 'EXPORT_PDF',
        entityType: 'Report',
        description: 'Exported PDF report',
      },
    });

    const listResponse = await request(app.getHttpServer())
      .get('/api/audit-logs?action=EXPORT_PDF&entityType=Report&search=PDF')
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(listResponse.body.items[0]).toMatchObject({
      id: log.id,
      action: 'EXPORT_PDF',
      entityType: 'Report',
      description: 'Exported PDF report',
    });

    const detailResponse = await request(app.getHttpServer())
      .get(`/api/audit-logs/${log.id}`)
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(detailResponse.body.id).toBe(log.id);
  });

  async function expectAuditActions(organizationId: string, actions: string[]) {
    const logs = await prisma.auditLog.findMany({
      where: {
        organizationId,
        action: { in: actions },
      },
    });

    expect(logs.map((log) => log.action)).toEqual(expect.arrayContaining(actions));
    for (const log of logs) {
      expect(log.organizationId).toBe(organizationId);
      expect(log.createdAt).toBeInstanceOf(Date);
      expect(log.description).toEqual(expect.any(String));
    }
  }

  function activityPayload(overrides: { quantity: number }) {
    return {
      activityType: 'DIESEL',
      recordDate: '2026-06-04',
      quantity: overrides.quantity,
      unit: 'L',
      sourceType: 'MANUAL',
    };
  }

  function activityDataRow(organizationId: string, quantity: number) {
    return {
      organizationId,
      activityType: 'DIESEL' as const,
      recordDate: new Date('2026-06-04'),
      quantity,
      unit: 'L',
      sourceType: 'MANUAL' as const,
    };
  }

  function factorPayload(overrides: { name: string; factorValue: number }) {
    return {
      name: overrides.name,
      type: 'EMISSION',
      activityType: 'DIESEL',
      unit: 'L',
      factorValue: overrides.factorValue,
      resultUnit: 'kgCO2e',
      sourceName: 'Manual test',
    };
  }
});

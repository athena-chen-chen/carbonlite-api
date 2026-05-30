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

describe('Document delete (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('document-delete');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  async function uploadTestDocument(token: string, name: string) {
    const response = await request(app.getHttpServer())
      .post('/api/documents/upload')
      .set(authHeader(token))
      .field('type', 'SPREADSHEET')
      .attach('file', Buffer.from('activityType,recordDate,quantity,unit\n'), {
        filename: name,
        contentType: 'text/csv',
      })
      .expect(201);

    return response.body;
  }

  it('allows the owner to delete their own document', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Owner Org`,
      email: `owner-${testRunId}@carbonlite-e2e.test`,
    });
    const document = await uploadTestDocument(
      user.accessToken,
      `${testRunId}-owner.csv`,
    );

    await request(app.getHttpServer())
      .delete(`/api/documents/${document.id}`)
      .set(authHeader(user.accessToken))
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          deletedDocument: true,
          deletedActivityRecords: 0,
        });
      });

    const deleted = await prisma.document.findUnique({
      where: { id: document.id },
    });
    expect(deleted).toBeNull();
  });

  it('returns 403 when deleting another organization document', async () => {
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} Org A`,
      email: `org-a-${testRunId}@carbonlite-e2e.test`,
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} Org B`,
      email: `org-b-${testRunId}@carbonlite-e2e.test`,
    });
    const documentA = await uploadTestDocument(
      userA.accessToken,
      `${testRunId}-org-a.csv`,
    );

    await request(app.getHttpServer())
      .delete(`/api/documents/${documentA.id}`)
      .set(authHeader(userB.accessToken))
      .expect(403);

    const stillExists = await prisma.document.findUnique({
      where: { id: documentA.id },
    });
    expect(stillExists).not.toBeNull();
  });

  it('deletes related imported ActivityData records when deleting a document', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Activity Org`,
      email: `activity-${testRunId}@carbonlite-e2e.test`,
    });
    const document = await uploadTestDocument(
      user.accessToken,
      `${testRunId}-activity.csv`,
    );

    const activity = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(user.accessToken))
      .send({
        documentId: document.id,
        activityType: 'DIESEL',
        recordDate: '2026-05-17',
        quantity: 12,
        unit: 'liters',
        sourceType: 'DOCUMENT_AI',
        sourceReference: testRunId,
        sourceDocumentId: document.id,
        sourceFileName: document.fileName,
      })
      .expect(201);

    const deleteResponse = await request(app.getHttpServer())
      .delete(`/api/documents/${document.id}`)
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(deleteResponse.body).toEqual({
      deletedDocument: true,
      deletedActivityRecords: 1,
    });

    const activityAfterDelete = await prisma.activityData.findUnique({
      where: { id: activity.body.id },
    });

    expect(activityAfterDelete).toBeNull();
  });

  it('stores source document metadata during document import', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Import Metadata Org`,
      email: `import-metadata-${testRunId}@carbonlite-e2e.test`,
    });
    const document = await uploadTestDocument(
      user.accessToken,
      `${testRunId}-import-metadata.csv`,
    );

    const confirmResponse = await request(app.getHttpServer())
      .post('/api/document-extraction/confirm')
      .set(authHeader(user.accessToken))
      .send({
        documentId: document.id,
        activities: [
          {
            activityType: 'DIESEL',
            recordDate: '2026-05-17',
            quantity: 12,
            unit: 'liters',
            sourceReference: `${testRunId}-import-metadata`,
            notes: 'Imported test row',
          },
        ],
      })
      .expect(201);

    const imported = await prisma.activityData.findUnique({
      where: { id: confirmResponse.body.createdIds[0] },
    });

    expect(imported?.sourceDocumentId).toBe(document.id);
    expect(imported?.sourceFileName).toBe(document.fileName);
  });

  it('does not delete unrelated manual records', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Manual Org`,
      email: `manual-${testRunId}@carbonlite-e2e.test`,
    });
    const document = await uploadTestDocument(
      user.accessToken,
      `${testRunId}-manual.csv`,
    );

    const manualActivity = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(user.accessToken))
      .send({
        activityType: 'DIESEL',
        recordDate: '2026-05-17',
        quantity: 8,
        unit: 'liters',
        sourceType: 'MANUAL',
        sourceReference: `${testRunId}-manual`,
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/api/documents/${document.id}`)
      .set(authHeader(user.accessToken))
      .expect(200);

    const manualAfterDelete = await prisma.activityData.findUnique({
      where: { id: manualActivity.body.id },
    });

    expect(manualAfterDelete).not.toBeNull();
  });

  it('does not delete another organization records with the same sourceDocumentId', async () => {
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} Source Org A`,
      email: `source-org-a-${testRunId}@carbonlite-e2e.test`,
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} Source Org B`,
      email: `source-org-b-${testRunId}@carbonlite-e2e.test`,
    });
    const documentA = await uploadTestDocument(
      userA.accessToken,
      `${testRunId}-source-a.csv`,
    );
    const activityB = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(userB.accessToken))
      .send({
        activityType: 'DIESEL',
        recordDate: '2026-05-17',
        quantity: 9,
        unit: 'liters',
        sourceType: 'DOCUMENT_AI',
        sourceReference: `${testRunId}-org-b`,
        sourceDocumentId: documentA.id,
        sourceFileName: 'other-org.csv',
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/api/documents/${documentA.id}`)
      .set(authHeader(userA.accessToken))
      .expect(200);

    const otherOrgRecord = await prisma.activityData.findUnique({
      where: { id: activityB.body.id },
    });
    expect(otherOrgRecord).not.toBeNull();
  });

  it('updates metrics summary and report document counts after deleting imported document data', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Metrics Org`,
      email: `metrics-${testRunId}@carbonlite-e2e.test`,
    });
    const document = await uploadTestDocument(
      user.accessToken,
      `${testRunId}-metrics.csv`,
    );
    const activity = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(user.accessToken))
      .send({
        documentId: document.id,
        activityType: 'DIESEL',
        recordDate: '2026-05-17',
        quantity: 10,
        unit: 'liters',
        sourceType: 'DOCUMENT_AI',
        sourceReference: `${testRunId}-metrics`,
        sourceDocumentId: document.id,
        sourceFileName: document.fileName,
      })
      .expect(201);

    await prisma.metricResult.create({
      data: {
        organizationId: user.user.organizationId,
        activityDataId: activity.body.id,
        metricType: 'CARBON_EMISSION',
        value: 26.8,
        unit: 'kgCO2e',
      },
    });

    const report = await request(app.getHttpServer())
      .post('/api/reports')
      .set(authHeader(user.accessToken))
      .send({ title: `${testRunId} Report`, reportingYear: 2026 })
      .expect(201);

    await prisma.document.update({
      where: { id: document.id },
      data: { reportId: report.body.id },
    });

    const summaryBeforeDelete = await request(app.getHttpServer())
      .get('/api/metrics/summary')
      .set(authHeader(user.accessToken))
      .expect(200);
    expect(summaryBeforeDelete.body.totalsByMetric).toEqual(
      expect.arrayContaining([expect.objectContaining({ count: 1 })]),
    );

    await request(app.getHttpServer())
      .delete(`/api/documents/${document.id}`)
      .set(authHeader(user.accessToken))
      .expect(200);

    const summaryAfterDelete = await request(app.getHttpServer())
      .get('/api/metrics/summary')
      .set(authHeader(user.accessToken))
      .expect(200);
    expect(summaryAfterDelete.body.totalsByMetric).toEqual([]);

    const reportAfterDelete = await request(app.getHttpServer())
      .get(`/api/reports/${report.body.id}`)
      .set(authHeader(user.accessToken))
      .expect(200);
    expect(reportAfterDelete.body.documents).toEqual([]);
  });

  it('returns 404 for a missing document', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Missing Org`,
      email: `missing-${testRunId}@carbonlite-e2e.test`,
    });

    await request(app.getHttpServer())
      .delete('/api/documents/missing-document-id')
      .set(authHeader(user.accessToken))
      .expect(404);
  });

  it('returns 401 without authentication', async () => {
    await request(app.getHttpServer())
      .delete('/api/documents/missing-document-id')
      .expect(401);
  });
});

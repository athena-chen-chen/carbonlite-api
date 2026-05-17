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
      .expect(204);

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

  it('does not delete imported ActivityData records when deleting a document', async () => {
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
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/api/documents/${document.id}`)
      .set(authHeader(user.accessToken))
      .expect(204);

    const activityAfterDelete = await prisma.activityData.findUnique({
      where: { id: activity.body.id },
    });

    expect(activityAfterDelete).not.toBeNull();
    expect(activityAfterDelete?.documentId).toBeNull();
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

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { openai } from '../src/openai/openai.client';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import {
  authHeader,
  cleanupTestData,
  createTestUser,
  uniqueTestId,
} from './helpers/factories';

describe('User activity events (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('activity-events');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
      .attach(
        'file',
        Buffer.from('activityType,recordDate,quantity,unit\nDIESEL,2026-05-31,10,liters\n'),
        {
          filename: name,
          contentType: 'text/csv',
        },
      )
      .expect(201);

    return response.body;
  }

  function mockExtractionResponse(activities: unknown[]) {
    jest.spyOn(openai.responses, 'create').mockResolvedValue({
      output_text: JSON.stringify({ activities }),
    } as never);
  }

  it('records an event after document upload without sensitive content', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Upload Org`,
      email: `upload-${testRunId}@carbonlite-e2e.test`,
    });
    const document = await uploadTestDocument(user.accessToken, `${testRunId}-upload.csv`);

    const event = await prisma.userActivityEvent.findFirst({
      where: {
        organizationId: user.user.organizationId,
        eventName: 'DOCUMENT_UPLOADED',
        entityId: document.id,
      },
    });

    expect(event).toMatchObject({
      userId: user.user.id,
      entityType: 'Document',
      entityId: document.id,
    });
    expect(JSON.stringify(event?.metadata)).not.toContain('DIESEL,2026-05-31');
    expect(JSON.stringify(event?.metadata)).not.toMatch(/password|token/i);
  });

  it('records extraction success and failure events', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Extraction Org`,
      email: `extraction-${testRunId}@carbonlite-e2e.test`,
    });
    const successDocument = await uploadTestDocument(
      user.accessToken,
      `${testRunId}-extract-success.csv`,
    );
    mockExtractionResponse([
      {
        activityType: 'DIESEL',
        recordDate: '2026-05-31',
        quantity: 10,
        unit: 'liters',
        sourceReference: 'test',
        notes: null,
      },
    ]);

    await request(app.getHttpServer())
      .post('/api/document-extraction/extract')
      .set(authHeader(user.accessToken))
      .send({ documentId: successDocument.id })
      .expect(201);

    const missingDocument = await uploadTestDocument(
      user.accessToken,
      `${testRunId}-extract-missing.csv`,
    );
    await prisma.document.update({
      where: { id: missingDocument.id },
      data: { fileUrl: '/uploads/missing-for-activity-events.csv' },
    });

    await request(app.getHttpServer())
      .post('/api/document-extraction/extract')
      .set(authHeader(user.accessToken))
      .send({ documentId: missingDocument.id })
      .expect(404);

    const events = await prisma.userActivityEvent.findMany({
      where: {
        organizationId: user.user.organizationId,
        eventName: {
          in: ['DOCUMENT_EXTRACT_STARTED', 'DOCUMENT_EXTRACT_SUCCEEDED', 'DOCUMENT_EXTRACT_FAILED'],
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    expect(events.some((event) => event.eventName === 'DOCUMENT_EXTRACT_STARTED')).toBe(true);
    expect(events.some((event) => event.eventName === 'DOCUMENT_EXTRACT_SUCCEEDED')).toBe(true);
    expect(events.some((event) => event.eventName === 'DOCUMENT_EXTRACT_FAILED')).toBe(true);
  });

  it('records report export client events and keeps organization isolation', async () => {
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} Report Org A`,
      email: `report-a-${testRunId}@carbonlite-e2e.test`,
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} Report Org B`,
      email: `report-b-${testRunId}@carbonlite-e2e.test`,
    });

    await request(app.getHttpServer())
      .post('/api/activity-events')
      .set(authHeader(userA.accessToken))
      .send({
        eventName: 'REPORT_EXPORTED_PDF',
        page: '/reports',
        url: 'https://carbonliteapp.ca/reports',
        entityType: 'Report',
        metadata: {
          recordsIncluded: 3,
          token: 'should-not-be-stored',
          fileContent: 'sensitive invoice text',
        },
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/activity-events')
      .set(authHeader(userB.accessToken))
      .send({
        eventName: 'REPORT_EXPORTED_PDF',
        page: '/reports',
        entityType: 'Report',
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get('/api/activity-events?eventName=REPORT_EXPORTED_PDF')
      .set(authHeader(userA.accessToken))
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      organizationId: userA.user.organizationId,
      eventName: 'REPORT_EXPORTED_PDF',
      page: '/reports',
    });
    expect(JSON.stringify(response.body.items[0].metadata)).toContain('recordsIncluded');
    expect(JSON.stringify(response.body.items[0].metadata)).not.toMatch(/token|invoice text/i);
  });
});

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
        Buffer.from(
          `activityType,recordDate,quantity,unit,notes\nDIESEL,2026-05-31,10,liters,${name}\n`,
        ),
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
    await prisma.user.update({
      where: { id: userA.user.id },
      data: { role: 'ADMIN' },
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

  it('lets users list only their own activity events', async () => {
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} Own Activity Org A`,
      email: `own-a-${testRunId}@carbonlite-e2e.test`,
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} Own Activity Org B`,
      email: `own-b-${testRunId}@carbonlite-e2e.test`,
    });

    await prisma.userActivityEvent.createMany({
      data: [
        {
          organizationId: userA.user.organizationId,
          userId: userA.user.id,
          eventName: 'DOCUMENT_UPLOADED',
          page: '/upload',
        },
        {
          organizationId: userB.user.organizationId,
          userId: userB.user.id,
          eventName: 'REPORT_GENERATED',
          page: '/reports',
        },
      ],
    });

    const response = await request(app.getHttpServer())
      .get('/api/activity-events')
      .set(authHeader(userA.accessToken))
      .expect(200);

    expect(response.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: userA.user.id,
          eventName: 'DOCUMENT_UPLOADED',
        }),
      ]),
    );
    expect(response.body.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: userB.user.id,
          eventName: 'REPORT_GENERATED',
        }),
      ]),
    );
  });

  it('lets admins list and filter activity across users and organizations', async () => {
    const admin = await createTestUser(app, {
      organizationName: `${testRunId} Admin Activity Org`,
      email: `activity-admin-${testRunId}@carbonlite-e2e.test`,
    });
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} Activity Filter Org A`,
      email: `activity-filter-a-${testRunId}@carbonlite-e2e.test`,
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} Activity Filter Org B`,
      email: `activity-filter-b-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { role: 'ADMIN' },
    });

    await prisma.userActivityEvent.createMany({
      data: [
        {
          organizationId: userA.user.organizationId,
          userId: userA.user.id,
          eventName: 'FEEDBACK_SUBMITTED',
          page: '/feedback',
          entityType: 'Feedback',
          entityId: 'feedback-a',
        },
        {
          organizationId: userB.user.organizationId,
          userId: userB.user.id,
          eventName: 'DOCUMENT_DELETED',
          page: '/upload',
          entityType: 'Document',
          entityId: 'doc-b',
        },
      ],
    });

    const response = await request(app.getHttpServer())
      .get(`/api/admin/activity?activityType=DOCUMENT_DELETED&organization=${encodeURIComponent(userB.user.organizationName)}`)
      .set(authHeader(admin.accessToken))
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      userId: userB.user.id,
      userEmail: userB.user.email,
      organizationId: userB.user.organizationId,
      organizationName: userB.user.organizationName,
      activityType: 'DOCUMENT_DELETED',
      entityType: 'Document',
      entityId: 'doc-b',
    });
  });

  it('does not allow normal users to access admin activity', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Non Admin Activity Org`,
      email: `non-admin-activity-${testRunId}@carbonlite-e2e.test`,
    });

    await request(app.getHttpServer())
      .get('/api/admin/activity')
      .set(authHeader(user.accessToken))
      .expect(403);
  });

  it('lets admins view active users for a selected period', async () => {
    const admin = await createTestUser(app, {
      organizationName: `${testRunId} Active Admin Org`,
      email: `active-admin-${testRunId}@carbonlite-e2e.test`,
    });
    const activeUser = await createTestUser(app, {
      organizationName: `${testRunId} Active User Org`,
      email: `active-user-${testRunId}@carbonlite-e2e.test`,
    });
    const oldUser = await createTestUser(app, {
      organizationName: `${testRunId} Old User Org`,
      email: `old-user-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { role: 'ADMIN' },
    });
    await prisma.user.update({
      where: { id: activeUser.user.id },
      data: { firstName: 'Active', lastName: 'Pilot' },
    });

    await prisma.userActivityEvent.createMany({
      data: [
        {
          organizationId: activeUser.user.organizationId,
          userId: activeUser.user.id,
          eventName: 'DOCUMENT_UPLOADED',
          createdAt: new Date('2026-06-10T12:00:00.000Z'),
        },
        {
          organizationId: activeUser.user.organizationId,
          userId: activeUser.user.id,
          eventName: 'REPORT_GENERATED',
          createdAt: new Date('2026-06-12T12:00:00.000Z'),
        },
        {
          organizationId: oldUser.user.organizationId,
          userId: oldUser.user.id,
          eventName: 'FEEDBACK_SUBMITTED',
          createdAt: new Date('2026-05-12T12:00:00.000Z'),
        },
      ],
    });

    const response = await request(app.getHttpServer())
      .get(
        `/api/admin/activity/active-users?dateFrom=2026-06-10&dateTo=2026-06-13&organizationId=${activeUser.user.organizationId}`,
      )
      .set(authHeader(admin.accessToken))
      .expect(200);

    expect(response.body.items).toEqual([
      expect.objectContaining({
        userId: activeUser.user.id,
        name: 'Active Pilot',
        email: activeUser.user.email,
        organizationName: activeUser.user.organizationName,
        activityCount: 2,
        mostRecentActivityType: 'REPORT_GENERATED',
      }),
    ]);
  });

  it('does not allow normal users to access admin active users', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Active Non Admin Org`,
      email: `active-non-admin-${testRunId}@carbonlite-e2e.test`,
    });

    await request(app.getHttpServer())
      .get('/api/admin/activity/active-users')
      .set(authHeader(user.accessToken))
      .expect(403);
  });
});

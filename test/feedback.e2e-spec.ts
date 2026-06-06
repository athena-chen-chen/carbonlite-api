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

describe('Feedback (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('feedback');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('creates feedback with organization and user agent context', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Org`,
      email: `submit-${testRunId}@carbonlite-e2e.test`,
    });

    const response = await request(app.getHttpServer())
      .post('/api/feedback')
      .set(authHeader(user.accessToken))
      .set('User-Agent', 'CarbonLite E2E Browser')
      .send({
        type: 'BUG',
        intent: 'Import activity rows',
        message: 'The import button stayed disabled.',
        email: 'pilot@example.com',
        page: '/upload',
        url: 'https://carbonliteapp.ca/upload',
      })
      .expect(201);

    expect(response.body).toMatchObject({
      type: 'BUG',
      intent: 'Import activity rows',
      message: 'The import button stayed disabled.',
      email: 'pilot@example.com',
      page: '/upload',
      url: 'https://carbonliteapp.ca/upload',
      organizationId: user.user.organizationId,
      userAgent: 'CarbonLite E2E Browser',
      status: 'NEW',
    });
    expect(response.body.createdAt).toEqual(expect.any(String));
  });

  it('lists and filters feedback by organization and status', async () => {
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} List Org A`,
      email: `list-a-${testRunId}@carbonlite-e2e.test`,
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} List Org B`,
      email: `list-b-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: userA.user.id },
      data: { role: 'ADMIN' },
    });

    await prisma.feedback.createMany({
      data: [
        {
          organizationId: userA.user.organizationId,
          type: 'SUGGESTION',
          intent: 'Review rows',
          message: 'Please add row confidence.',
          page: '/upload',
          status: 'NEW',
        },
        {
          organizationId: userA.user.organizationId,
          type: 'QUESTION',
          intent: 'Close issue',
          message: 'Can this be closed?',
          page: '/reports',
          status: 'CLOSED',
        },
        {
          organizationId: userB.user.organizationId,
          type: 'BUG',
          intent: 'Other org',
          message: 'Should not appear.',
          page: '/metrics-summary',
          status: 'NEW',
        },
      ],
    });

    const response = await request(app.getHttpServer())
      .get('/api/feedback?status=NEW')
      .set(authHeader(userA.accessToken))
      .expect(200);

    expect(response.body.total).toBe(1);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      type: 'SUGGESTION',
      status: 'NEW',
      organizationId: userA.user.organizationId,
    });
  });

  it('updates feedback status within the same organization only', async () => {
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} Status Org A`,
      email: `status-a-${testRunId}@carbonlite-e2e.test`,
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} Status Org B`,
      email: `status-b-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.updateMany({
      where: { id: { in: [userA.user.id, userB.user.id] } },
      data: { role: 'ADMIN' },
    });

    const feedback = await prisma.feedback.create({
      data: {
        organizationId: userA.user.organizationId,
        type: 'OTHER',
        intent: 'Status test',
        message: 'Change my status.',
      },
    });

    await request(app.getHttpServer())
      .patch(`/api/feedback/${feedback.id}/status`)
      .set(authHeader(userB.accessToken))
      .send({ status: 'REVIEWED' })
      .expect(404);

    const response = await request(app.getHttpServer())
      .patch(`/api/feedback/${feedback.id}/status`)
      .set(authHeader(userA.accessToken))
      .send({ status: 'REVIEWED' })
      .expect(200);

    expect(response.body).toMatchObject({
      id: feedback.id,
      status: 'REVIEWED',
    });
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer())
      .post('/api/feedback')
      .send({
        type: 'QUESTION',
        intent: 'Ask question',
        message: 'Can I submit without auth?',
      })
      .expect(401);
  });
});

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
      userId: user.user.id,
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

  it('allows admins to list feedback across users and organizations', async () => {
    const admin = await createTestUser(app, {
      organizationName: `${testRunId} Admin Feedback Org`,
      email: `admin-feedback-${testRunId}@carbonlite-e2e.test`,
    });
    const normalUser = await createTestUser(app, {
      organizationName: `${testRunId} Submitter Org`,
      email: `submitter-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { role: 'ADMIN' },
    });

    const submitted = await prisma.feedback.create({
      data: {
        organizationId: normalUser.user.organizationId,
        userId: normalUser.user.id,
        type: 'SUGGESTION',
        intent: 'Use reports',
        message: 'Please make the report easier to export.',
        page: '/reports',
        url: 'https://carbonliteapp.ca/reports',
        status: 'NEW',
      },
    });

    const response = await request(app.getHttpServer())
      .get('/api/admin/feedback?status=NEW')
      .set(authHeader(admin.accessToken))
      .expect(200);

    expect(response.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: submitted.id,
          organizationId: normalUser.user.organizationId,
          userId: normalUser.user.id,
          status: 'NEW',
          user: expect.objectContaining({
            id: normalUser.user.id,
            email: normalUser.user.email,
          }),
          organization: expect.objectContaining({
            id: normalUser.user.organizationId,
            name: normalUser.user.organizationName,
          }),
        }),
      ]),
    );
  });

  it('does not allow normal users to access admin feedback', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Non Admin Org`,
      email: `non-admin-${testRunId}@carbonlite-e2e.test`,
    });

    await request(app.getHttpServer())
      .get('/api/admin/feedback?status=NEW')
      .set(authHeader(user.accessToken))
      .expect(403);
  });

  it('allows admins to update feedback status across organizations', async () => {
    const admin = await createTestUser(app, {
      organizationName: `${testRunId} Admin Status Org`,
      email: `admin-status-${testRunId}@carbonlite-e2e.test`,
    });
    const normalUser = await createTestUser(app, {
      organizationName: `${testRunId} Status Submitter Org`,
      email: `status-submitter-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { role: 'ADMIN' },
    });

    const feedback = await prisma.feedback.create({
      data: {
        organizationId: normalUser.user.organizationId,
        userId: normalUser.user.id,
        type: 'BUG',
        intent: 'Admin status update',
        message: 'Please triage this.',
        status: 'NEW',
      },
    });

    const response = await request(app.getHttpServer())
      .patch(`/api/admin/feedback/${feedback.id}/status`)
      .set(authHeader(admin.accessToken))
      .send({ status: 'REVIEWED' })
      .expect(200);

    expect(response.body).toMatchObject({
      id: feedback.id,
      status: 'REVIEWED',
      organizationId: normalUser.user.organizationId,
      userId: normalUser.user.id,
    });
  });

  it('does not allow normal users to update admin feedback status', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Non Admin Status Org`,
      email: `non-admin-status-${testRunId}@carbonlite-e2e.test`,
    });

    const feedback = await prisma.feedback.create({
      data: {
        organizationId: user.user.organizationId,
        userId: user.user.id,
        type: 'QUESTION',
        intent: 'Blocked update',
        message: 'Normal users should not update this.',
        status: 'NEW',
      },
    });

    await request(app.getHttpServer())
      .patch(`/api/admin/feedback/${feedback.id}/status`)
      .set(authHeader(user.accessToken))
      .send({ status: 'REVIEWED' })
      .expect(403);
  });

  it('returns an empty admin feedback list instead of 404', async () => {
    const admin = await createTestUser(app, {
      organizationName: `${testRunId} Empty Admin Org`,
      email: `empty-admin-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { role: 'ADMIN' },
    });

    const response = await request(app.getHttpServer())
      .get('/api/admin/feedback?status=DISMISSED')
      .set(authHeader(admin.accessToken))
      .expect(200);

    expect(response.body).toMatchObject({
      items: [],
      total: 0,
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

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

describe('Role-based access control (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('rbac');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('allows ADMIN users to access internal management endpoints', async () => {
    const admin = await createTestUser(app, {
      organizationName: `${testRunId} Admin Org`,
      email: `admin-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { role: 'ADMIN' },
    });

    await request(app.getHttpServer())
      .get('/api/feedback')
      .set(authHeader(admin.accessToken))
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/activity-events')
      .set(authHeader(admin.accessToken))
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/audit-logs')
      .set(authHeader(admin.accessToken))
      .expect(200);
  });

  it('returns 403 for USER access to internal management endpoints', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} User Org`,
      email: `user-${testRunId}@carbonlite-e2e.test`,
    });

    await request(app.getHttpServer())
      .get('/api/feedback')
      .set(authHeader(user.accessToken))
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/activity-events')
      .set(authHeader(user.accessToken))
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/audit-logs')
      .set(authHeader(user.accessToken))
      .expect(403);
  });

  it('still allows USER accounts to submit feedback and activity events', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Submit Org`,
      email: `submit-${testRunId}@carbonlite-e2e.test`,
    });

    await request(app.getHttpServer())
      .post('/api/feedback')
      .set(authHeader(user.accessToken))
      .send({
        type: 'SUGGESTION',
        intent: 'Test the report workflow',
        message: 'A short pilot suggestion.',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/activity-events')
      .set(authHeader(user.accessToken))
      .send({
        eventName: 'REPORT_VIEWED',
        page: '/reports',
      })
      .expect(201);
  });

  it('returns 401 when authentication is missing', async () => {
    await request(app.getHttpServer()).get('/api/feedback').expect(401);
    await request(app.getHttpServer()).get('/api/activity-events').expect(401);
    await request(app.getHttpServer()).get('/api/audit-logs').expect(401);
  });
});

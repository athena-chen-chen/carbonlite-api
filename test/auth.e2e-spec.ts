import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import {
  cleanupTestData,
  createTestUser,
  loginAndGetToken,
  uniqueTestId,
} from './helpers/factories';

describe('Auth MVP (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('auth');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('registers a new user and organization', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({
        organizationName: `${testRunId} Register Org`,
        email: `register-${testRunId}@carbonlite-e2e.test`,
        password: 'password123',
      })
      .expect(201);

    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.user).toMatchObject({
      email: `register-${testRunId}@carbonlite-e2e.test`,
      organizationName: `${testRunId} Register Org`,
    });
    expect(response.body.user.organizationId).toEqual(expect.any(String));
  });

  it('rejects duplicate email registration', async () => {
    const email = `duplicate-${testRunId}@carbonlite-e2e.test`;

    await createTestUser(app, {
      organizationName: `${testRunId} Duplicate Org`,
      email,
    });

    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({
        organizationName: `${testRunId} Duplicate Org 2`,
        email,
        password: 'password123',
      })
      .expect(409);
  });

  it('logs in with valid credentials', async () => {
    const email = `login-${testRunId}@carbonlite-e2e.test`;
    const password = 'password123';

    await createTestUser(app, {
      organizationName: `${testRunId} Login Org`,
      email,
      password,
    });

    const token = await loginAndGetToken(app, email, password);

    expect(token).toEqual(expect.any(String));
  });

  it('rejects an invalid password', async () => {
    const email = `invalid-password-${testRunId}@carbonlite-e2e.test`;

    await createTestUser(app, {
      organizationName: `${testRunId} Invalid Password Org`,
      email,
      password: 'password123',
    });

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'wrong-password' })
      .expect(401);
  });

  it('rejects an invalid token', async () => {
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('rejects missing credentials on a protected route', async () => {
    await request(app.getHttpServer()).get('/api/activity-data').expect(401);
  });
});

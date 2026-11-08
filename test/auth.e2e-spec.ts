import { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
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

describe('Auth MVP (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('auth');
  const originalPublicRegistrationEnabled =
    process.env.PUBLIC_REGISTRATION_ENABLED;

  beforeAll(async () => {
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  beforeEach(() => {
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
    if (originalPublicRegistrationEnabled === undefined) {
      delete process.env.PUBLIC_REGISTRATION_ENABLED;
    } else {
      process.env.PUBLIC_REGISTRATION_ENABLED = originalPublicRegistrationEnabled;
    }
  });

  it('denies public registration when server configuration is disabled', async () => {
    process.env.PUBLIC_REGISTRATION_ENABLED = 'false';
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({
        organizationName: `${testRunId} Denied Org`,
        email: `denied-${testRunId}@carbonlite-e2e.test`,
        password: 'Fictional-Test-Only!2026',
      })
      .expect(403);
  });

  it('registers a new user and organization', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({
        organizationName: `${testRunId} Register Org`,
        email: `register-${testRunId}@carbonlite-e2e.test`,
        password: 'Fictional-Test-Only!2026',
      })
      .expect(201);

    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.user).toMatchObject({
      email: `register-${testRunId}@carbonlite-e2e.test`,
      organizationName: `${testRunId} Register Org`,
      role: 'USER',
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
        password: 'Fictional-Test-Only!2026',
      })
      .expect(409);
  });

  it('logs in with valid credentials', async () => {
    const email = `login-${testRunId}@carbonlite-e2e.test`;
    const password = 'Fictional-Test-Only!2026';

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
      password: 'Fictional-Test-Only!2026',
    });

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'wrong-password' })
      .expect(401);
  });

  it('rejects login and existing JWTs after the organization is suspended', async () => {
    const email = `suspended-${testRunId}@carbonlite-e2e.test`;
    const password = 'Fictional-Test-Only!2026';
    const account = await createTestUser(app, {
      organizationName: `${testRunId} Suspended Org`,
      email,
      password,
    });

    await prisma.organization.update({
      where: { id: account.user.organizationId },
      data: { customerStatus: 'SUSPENDED' },
    });

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password })
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set(authHeader(account.accessToken))
      .expect(401);
  });

  it('permits exactly one concurrent invitation-token consumption', async () => {
    const email = `concurrent-invite-${testRunId}@carbonlite-e2e.test`;
    const account = await createTestUser(app, {
      organizationName: `${testRunId} Concurrent Invite Org`,
      email,
    });
    const inviteToken = `${testRunId}-concurrent-invite-token`;
    const tokenHash = createHash('sha256').update(inviteToken).digest('hex');

    await prisma.user.update({
      where: { id: account.user.id },
      data: {
        passwordSetupRequired: true,
        passwordSetupTokenHash: tokenHash,
        passwordSetupTokenExpiresAt: new Date(Date.now() + 60_000),
        passwordSetupTokenUsedAt: null,
      },
    });
    const membershipCountBefore = await prisma.membership.count({
      where: { userId: account.user.id },
    });

    const responses = await Promise.all([
      request(app.getHttpServer())
        .post('/api/auth/set-password')
        .send({ token: inviteToken, password: 'Concurrent-Test-Only!2026-A' }),
      request(app.getHttpServer())
        .post('/api/auth/set-password')
        .send({ token: inviteToken, password: 'Concurrent-Test-Only!2026-B' }),
    ]);

    expect(responses.map(response => response.status).sort()).toEqual([
      201,
      401,
    ]);
    await expect(
      prisma.user.count({ where: { email } }),
    ).resolves.toBe(1);
    await expect(
      prisma.membership.count({ where: { userId: account.user.id } }),
    ).resolves.toBe(membershipCountBefore);
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: account.user.id } }),
    ).resolves.toMatchObject({
      passwordSetupRequired: false,
      passwordSetupTokenHash: tokenHash,
      passwordSetupTokenUsedAt: expect.any(Date),
    });

    await request(app.getHttpServer())
      .post('/api/auth/set-password')
      .send({ token: inviteToken, password: 'Concurrent-Test-Only!2026-C' })
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

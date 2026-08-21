import { INestApplication } from '@nestjs/common';
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

describe('Admin pilot reviewers (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('pilot-reviewer');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('creates a read-only pilot reviewer and returns an invite link', async () => {
    const admin = await createTestUser(app, {
      organizationName: `${testRunId} Admin Org`,
      email: `admin-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { role: 'ADMIN' },
    });
    const adminToken = await loginAndGetToken(app, admin.user.email, admin.password);
    const reviewerEmail = `reviewer-${testRunId}@carbonlite-e2e.test`;

    const response = await request(app.getHttpServer())
      .post('/api/admin/pilot-reviewers')
      .set(authHeader(adminToken))
      .send({
        name: 'Test Reviewer',
        email: reviewerEmail,
        workspace: `${testRunId} CarbonLite Sample Workspace`,
        expires: '2026-09-14',
      })
      .expect(201);

    expect(response.body).toMatchObject({
      success: true,
      pilotReviewer: {
        name: 'Test Reviewer',
        email: reviewerEmail,
        accountType: 'PILOT_REVIEWER',
        workspaceName: `${testRunId} CarbonLite Sample Workspace`,
      },
    });
    expect(response.body.inviteLink).toMatch(
      /^http:\/\/localhost:5173\/set-password\?token=.+/,
    );
    expect(response.body).not.toHaveProperty('passwordHash');
    expect(response.body).not.toHaveProperty('passwordSetupTokenHash');

    const reviewer = await prisma.user.findUniqueOrThrow({
      where: { email: reviewerEmail },
      include: { memberships: true, organization: true },
    });
    expect(reviewer.accountType).toBe('PILOT_REVIEWER');
    expect(reviewer.role).toBe('USER');
    expect(reviewer.passwordSetupRequired).toBe(true);
    expect(reviewer.passwordSetupTokenHash).toEqual(expect.any(String));
    expect(reviewer.passwordSetupTokenExpiresAt).toBeInstanceOf(Date);
    expect(reviewer.memberships).toHaveLength(1);
    expect(reviewer.memberships[0]).toMatchObject({
      organizationId: reviewer.organizationId,
      role: 'VIEWER',
    });
    await expect(
      prisma.activityData.count({
        where: { organizationId: reviewer.organizationId },
      }),
    ).resolves.toBe(10);
    await expect(
      prisma.activityData.count({
        where: {
          organizationId: reviewer.organizationId,
          activityType: 'WATER',
          reportTreatment: 'TRACKED_ONLY',
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.report.count({
        where: {
          organizationId: reviewer.organizationId,
          title: 'CarbonLite Pilot Sample Emissions Data Readiness Report',
        },
      }),
    ).resolves.toBe(1);

    const inviteToken = new URL(response.body.inviteLink).searchParams.get('token');
    expect(inviteToken).toEqual(expect.any(String));
    expect(response.body.inviteLink).not.toContain(
      reviewer.passwordSetupTokenHash ?? '',
    );

    const passwordResponse = await request(app.getHttpServer())
      .post('/api/auth/password-reset/confirm')
      .send({ token: inviteToken, password: 'password123' })
      .expect(201);

    expect(passwordResponse.body.user).toMatchObject({
      email: reviewerEmail,
      accountType: 'PILOT_REVIEWER',
      organizationName: `${testRunId} CarbonLite Sample Workspace`,
    });

    const token = await loginAndGetToken(app, reviewerEmail, 'password123');
    expect(token).toEqual(expect.any(String));

    const recordsResponse = await request(app.getHttpServer())
      .get('/api/activity-data?pageSize=20')
      .set(authHeader(token))
      .expect(200);
    expect(recordsResponse.body.items).toHaveLength(10);

    const summaryResponse = await request(app.getHttpServer())
      .get('/api/metrics/calculation-summary')
      .set(authHeader(token))
      .expect(200);
    expect(summaryResponse.body).toMatchObject({
      totalEstimatedEmissionsKgCO2e: 37285,
      totalRecordsFound: 10,
      recordsCalculated: 9,
      skippedReasons: {
        trackedOnly: 1,
      },
    });
    expect(summaryResponse.body.categoryBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ activityType: 'ELECTRICITY', emissions: 33247 }),
        expect.objectContaining({ activityType: 'NATURAL_GAS', emissions: 1890 }),
        expect.objectContaining({ activityType: 'GASOLINE', emissions: 1155 }),
        expect.objectContaining({ activityType: 'DIESEL', emissions: 268 }),
        expect.objectContaining({ activityType: 'AIR_TRAVEL', emissions: 575 }),
        expect.objectContaining({ activityType: 'HOTEL', emissions: 150 }),
      ]),
    );

    await request(app.getHttpServer())
      .post('/api/admin/demo-data/reset')
      .set(authHeader(token))
      .send({ confirmation: 'RESET DEMO DATA' })
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/conversion-factors')
      .set(authHeader(token))
      .expect(200);

    const factorMutationMessage =
      'Pilot reviewer accounts are read-only and cannot modify emission factors.';

    const createFactorResponse = await request(app.getHttpServer())
      .post('/api/conversion-factors')
      .set(authHeader(token))
      .send({})
      .expect(403);
    expect(JSON.stringify(createFactorResponse.body)).toContain(
      factorMutationMessage,
    );

    const updateFactorResponse = await request(app.getHttpServer())
      .patch('/api/conversion-factors/factor-1')
      .set(authHeader(token))
      .send({ factorValue: 1 })
      .expect(403);
    expect(JSON.stringify(updateFactorResponse.body)).toContain(
      factorMutationMessage,
    );

    const deleteFactorResponse = await request(app.getHttpServer())
      .delete('/api/conversion-factors/factor-1')
      .set(authHeader(token))
      .expect(403);
    expect(JSON.stringify(deleteFactorResponse.body)).toContain(
      factorMutationMessage,
    );
  });

  it('does not return 404 for valid admin pilot reviewer POST requests', async () => {
    const admin = await createTestUser(app, {
      organizationName: `${testRunId} Route Admin Org`,
      email: `route-admin-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { role: 'ADMIN' },
    });
    const adminToken = await loginAndGetToken(app, admin.user.email, admin.password);

    const response = await request(app.getHttpServer())
      .post('/api/admin/pilot-reviewers')
      .set(authHeader(adminToken))
      .send({
        name: 'Route Reviewer',
        email: `route-reviewer-${testRunId}@carbonlite-e2e.test`,
        workspace: `${testRunId} Route Sample Workspace`,
      });

    expect(response.status).not.toBe(404);
    expect(response.status).toBe(201);
    expect(response.body.inviteLink).toEqual(expect.any(String));
  });

  it('regenerates a pilot reviewer invite link for admins', async () => {
    const admin = await createTestUser(app, {
      organizationName: `${testRunId} Regenerate Admin Org`,
      email: `regenerate-admin-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { role: 'ADMIN' },
    });
    const adminToken = await loginAndGetToken(app, admin.user.email, admin.password);
    const reviewerEmail = `regenerate-reviewer-${testRunId}@carbonlite-e2e.test`;

    const createResponse = await request(app.getHttpServer())
      .post('/api/admin/pilot-reviewers')
      .set(authHeader(adminToken))
      .send({
        name: 'Regenerate Reviewer',
        email: reviewerEmail,
        workspace: `${testRunId} Regenerate Sample Workspace`,
      })
      .expect(201);
    const beforeReviewer = await prisma.user.findUniqueOrThrow({
      where: { email: reviewerEmail },
    });

    const response = await request(app.getHttpServer())
      .post('/api/admin/pilot-reviewers/regenerate-invite')
      .set(authHeader(adminToken))
      .send({ email: ` ${reviewerEmail.toUpperCase()} ` })
      .expect(201);

    expect(response.body).toMatchObject({
      success: true,
      message: 'Invite link regenerated.',
      pilotReviewer: {
        email: reviewerEmail,
        accountType: 'PILOT_REVIEWER',
        workspaceName: `${testRunId} Regenerate Sample Workspace`,
        status: 'Active',
      },
    });
    expect(response.body.inviteLink).toMatch(
      /^http:\/\/localhost:5173\/set-password\?token=.+/,
    );
    expect(response.body.inviteLink).not.toBe(createResponse.body.inviteLink);

    const afterReviewer = await prisma.user.findUniqueOrThrow({
      where: { email: reviewerEmail },
    });
    expect(afterReviewer.organizationId).toBe(beforeReviewer.organizationId);
    expect(afterReviewer.accountType).toBe('PILOT_REVIEWER');
    expect(afterReviewer.role).toBe('USER');
    expect(afterReviewer.passwordSetupTokenHash).not.toBe(
      beforeReviewer.passwordSetupTokenHash,
    );

    await request(app.getHttpServer())
      .post('/api/admin/pilot-reviewers/regenerate-invite')
      .set(authHeader((await createTestUser(app, {
        organizationName: `${testRunId} Regenerate Member Org`,
        email: `regenerate-member-${testRunId}@carbonlite-e2e.test`,
      })).accessToken))
      .send({ email: reviewerEmail })
      .expect(403);
  });

  it('rejects non-admin pilot reviewer creation', async () => {
    const member = await createTestUser(app, {
      organizationName: `${testRunId} Member Org`,
      email: `member-${testRunId}@carbonlite-e2e.test`,
    });

    await request(app.getHttpServer())
      .post('/api/admin/pilot-reviewers')
      .set(authHeader(member.accessToken))
      .send({
        name: 'Blocked Reviewer',
        email: `blocked-${testRunId}@carbonlite-e2e.test`,
        workspace: `${testRunId} Blocked Sample Workspace`,
      })
      .expect(403);
  });

  it('deactivates a pilot reviewer without deleting sample workspace data', async () => {
    const admin = await createTestUser(app, {
      organizationName: `${testRunId} Deactivate Admin Org`,
      email: `deactivate-admin-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { role: 'ADMIN' },
    });
    const adminToken = await loginAndGetToken(app, admin.user.email, admin.password);
    const reviewerEmail = `deactivate-reviewer-${testRunId}@carbonlite-e2e.test`;

    const createResponse = await request(app.getHttpServer())
      .post('/api/admin/pilot-reviewers')
      .set(authHeader(adminToken))
      .send({
        name: 'Deactivate Reviewer',
        email: reviewerEmail,
        workspace: `${testRunId} Deactivate Sample Workspace`,
      })
      .expect(201);

    const reviewer = await prisma.user.findUniqueOrThrow({
      where: { email: reviewerEmail },
    });
    await expect(
      prisma.activityData.count({ where: { organizationId: reviewer.organizationId } }),
    ).resolves.toBe(10);

    const response = await request(app.getHttpServer())
      .post('/api/admin/pilot-reviewers/deactivate')
      .set(authHeader(adminToken))
      .send({ email: ` ${reviewerEmail.toUpperCase()} ` })
      .expect(201);

    expect(response.body).toMatchObject({
      success: true,
      message: 'This pilot reviewer account has been deactivated.',
      pilotReviewer: {
        email: reviewerEmail,
        status: 'Deactivated',
      },
    });
    await expect(
      prisma.user.findUnique({ where: { email: reviewerEmail } }),
    ).resolves.toMatchObject({ isActive: false });
    await expect(
      prisma.activityData.count({ where: { organizationId: reviewer.organizationId } }),
    ).resolves.toBe(10);

    const inviteToken = new URL(createResponse.body.inviteLink).searchParams.get('token');
    await request(app.getHttpServer())
      .post('/api/auth/password-reset/confirm')
      .send({ token: inviteToken, password: 'password123' })
      .expect(401);
  });

  it('rejects markdown mailto email values without creating a user', async () => {
    const admin = await createTestUser(app, {
      organizationName: `${testRunId} Email Admin Org`,
      email: `email-admin-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { role: 'ADMIN' },
    });
    const adminToken = await loginAndGetToken(app, admin.user.email, admin.password);
    const malformedEmail = '[mint_pp@hotmail.com](mailto:mint_pp@hotmail.com)';

    const response = await request(app.getHttpServer())
      .post('/api/admin/pilot-reviewers')
      .set(authHeader(adminToken))
      .send({
        name: 'Malformed Reviewer',
        email: malformedEmail,
        workspace: `${testRunId} Email Sample Workspace`,
      })
      .expect(400);

    expect(JSON.stringify(response.body)).toContain(
      'Please enter a valid email address, for example name@example.com.',
    );
    await expect(
      prisma.user.findUnique({ where: { email: malformedEmail } }),
    ).resolves.toBeNull();
  });

  it('supports ADMIN_SCRIPT_TOKEN authorization', async () => {
    const originalToken = process.env.ADMIN_SCRIPT_TOKEN;
    process.env.ADMIN_SCRIPT_TOKEN = `${testRunId}-script-token`;

    try {
      const response = await request(app.getHttpServer())
        .post('/api/admin/pilot-reviewers')
        .set('Authorization', `Bearer ${process.env.ADMIN_SCRIPT_TOKEN}`)
        .send({
          name: 'Script Reviewer',
          email: `script-reviewer-${testRunId}@carbonlite-e2e.test`,
          workspace: `${testRunId} Script Sample Workspace`,
        })
        .expect(201);

      expect(response.body.inviteLink).toEqual(expect.any(String));
      expect(response.body.pilotReviewer).toMatchObject({
        accountType: 'PILOT_REVIEWER',
        workspaceName: `${testRunId} Script Sample Workspace`,
      });
    } finally {
      if (originalToken === undefined) {
        delete process.env.ADMIN_SCRIPT_TOKEN;
      } else {
        process.env.ADMIN_SCRIPT_TOKEN = originalToken;
      }
    }
  });
});

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { SYNTHETIC_ONLY_PILOT_NOTICE } from '../src/common/policies/synthetic-only-pilot';
import {
  GOLDEN_SAMPLE_REPORT_TITLE,
  GOLDEN_SAMPLE_SOURCE_FILE,
} from '../src/sample-data/golden-sample-data.service';
import { createE2eApp } from './helpers/e2e-app';
import {
  authHeader,
  cleanupTestData,
  createTestUser,
  loginAndGetToken,
  uniqueTestId,
} from './helpers/factories';

describe('Real customer onboarding stays free of demo data (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let operatorToken: string;
  const testRunId = uniqueTestId('customer-demo-safety');
  const password = 'Fictional-Test-Only!2026';

  beforeAll(async () => {
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
    process.env.DEMO_RESET_ENABLED = 'true';
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
    const operator = await createTestUser(app, {
      organizationName: `${testRunId} Platform Operations`,
      email: `operator-${testRunId}@carbonlite-e2e.test`,
      password,
    });
    await prisma.user.update({
      where: { id: operator.user.id },
      data: { role: 'ADMIN' },
    });
    operatorToken = await loginAndGetToken(app, operator.user.email, password);
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  const invite = async (
    label: string,
    purpose: 'CUSTOMER' | 'DEMO',
    email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${testRunId}@carbonlite-e2e.test`,
  ) => request(app.getHttpServer())
    .post('/api/admin/pilot-reviewers')
    .set(authHeader(operatorToken))
    .send({
      name: `${label} Admin`,
      email,
      workspaceName: `${testRunId} ${label}`,
      invitationPurpose: purpose,
    })
    .expect(201);

  const acceptInvite = async (inviteLink: string) => {
    const token = new URL(inviteLink).searchParams.get('token');
    expect(token).toEqual(expect.any(String));
    return request(app.getHttpServer())
      .post('/api/auth/set-password')
      .send({ token, password })
      .expect(201);
  };

  const provision = (organization: { id: string; slug: string }, userId: string) =>
    request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/paid-pilot')
      .set(authHeader(operatorToken))
      .send({
        organizationId: organization.id,
        confirmationOrganizationId: organization.id,
        confirmationOrganizationSlug: organization.slug,
        primaryAdminUserId: userId,
        confirmProvision: true,
      });

  it('keeps customer A clean, preserves demo B, and cleans legacy C safely', async () => {
    const customerEmail = `customer-a-${testRunId}@carbonlite-e2e.test`;
    const firstCustomerInvite = await invite('Customer A', 'CUSTOMER', customerEmail);
    const repeatedCustomerInvite = await invite('Customer A', 'CUSTOMER', customerEmail);
    const customerUser = await prisma.user.findUniqueOrThrow({
      where: { email: customerEmail },
      include: { organization: true, memberships: true },
    });
    expect(customerUser.organization).toMatchObject({
      customerStatus: 'PENDING',
      allowDemoFactorsForCalculations: false,
    });
    expect(customerUser.memberships).toHaveLength(1);
    await expect(prisma.organization.count({
      where: { name: `${testRunId} Customer A` },
    })).resolves.toBe(1);
    await expect(prisma.activityData.count({
      where: { organizationId: customerUser.organizationId },
    })).resolves.toBe(0);
    await expect(prisma.report.count({
      where: { organizationId: customerUser.organizationId },
    })).resolves.toBe(0);
    expect(firstCustomerInvite.body.invitationPurpose).toBe('CUSTOMER');
    expect(firstCustomerInvite.body.usageNotice).toBe(
      SYNTHETIC_ONLY_PILOT_NOTICE,
    );

    const customerAuth = await acceptInvite(repeatedCustomerInvite.body.inviteLink);
    await provision(customerUser.organization, customerUser.id)
      .expect(201)
      .expect(({ body }) => {
        expect(body.status).toBe('PROVISIONED');
        expect(body.usageNotice).toBe(SYNTHETIC_ONLY_PILOT_NOTICE);
      });
    await expect(prisma.organization.findUniqueOrThrow({
      where: { id: customerUser.organizationId },
    })).resolves.toMatchObject({
      customerStatus: 'ACTIVE',
      allowDemoFactorsForCalculations: false,
    });
    await request(app.getHttpServer())
      .get('/api/metrics/summary')
      .set(authHeader(customerAuth.body.accessToken))
      .expect(200)
      .expect(({ body }) => expect(body.totalEstimatedEmissionsKgCO2e).toBe(0));
    await request(app.getHttpServer())
      .post('/api/admin/demo-data/reset')
      .set(authHeader(customerAuth.body.accessToken))
      .send({ confirmation: 'RESET DEMO DATA' })
      .expect(403);

    const demoEmail = `demo-b-${testRunId}@carbonlite-e2e.test`;
    const demoInvite = await invite('Demo B', 'DEMO', demoEmail);
    const demoUser = await prisma.user.findUniqueOrThrow({
      where: { email: demoEmail },
      include: { organization: true },
    });
    expect(demoInvite.body.invitationPurpose).toBe('DEMO');
    expect(demoUser.organization).toMatchObject({
      customerStatus: 'DEMO',
      allowDemoFactorsForCalculations: true,
    });
    await expect(prisma.activityData.count({
      where: {
        organizationId: demoUser.organizationId,
        sourceReference: GOLDEN_SAMPLE_SOURCE_FILE,
      },
    })).resolves.toBe(10);

    const legacyEmail = `legacy-c-${testRunId}@carbonlite-e2e.test`;
    await invite('Legacy C', 'DEMO', legacyEmail);
    const customerConversionInvite = await invite('Legacy C', 'CUSTOMER', legacyEmail);
    const legacyUser = await prisma.user.findUniqueOrThrow({
      where: { email: legacyEmail },
      include: { organization: true },
    });
    const legitimate = await prisma.activityData.create({
      data: {
        organizationId: legacyUser.organizationId,
        activityType: 'GASOLINE',
        recordDate: new Date('2026-10-01T00:00:00.000Z'),
        quantity: 1,
        unit: 'liters',
        sourceType: 'MANUAL',
        sourceReference: 'legitimate-customer-record',
      },
    });
    const sampleActivity = await prisma.activityData.findFirstOrThrow({
      where: {
        organizationId: legacyUser.organizationId,
        sourceReference: GOLDEN_SAMPLE_SOURCE_FILE,
      },
    });
    await prisma.metricResult.create({
      data: {
        organizationId: legacyUser.organizationId,
        activityDataId: sampleActivity.id,
        metricType: 'CARBON_EMISSION',
        value: 1,
        unit: 'kgCO2e',
      },
    });
    await acceptInvite(customerConversionInvite.body.inviteLink);

    await provision(legacyUser.organization, legacyUser.id)
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('DEMO_DATA_PRESENT'));
    await request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/golden-sample-cleanup')
      .set(authHeader(customerAuth.body.accessToken))
      .send({
        organizationId: legacyUser.organizationId,
        confirmationOrganizationId: legacyUser.organizationId,
        confirmationOrganizationSlug: legacyUser.organization.slug,
        confirmCleanup: true,
      })
      .expect(403);

    const cleanupCommand = {
      organizationId: legacyUser.organizationId,
      confirmationOrganizationId: legacyUser.organizationId,
      confirmationOrganizationSlug: legacyUser.organization.slug,
      confirmCleanup: true,
    };
    await request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/golden-sample-cleanup')
      .set(authHeader(operatorToken))
      .send(cleanupCommand)
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({
        status: 'CLEANED',
        activityRecordsDeleted: 10,
        metricResultsDeleted: 1,
        reportsDeleted: 1,
      }));
    await request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/golden-sample-cleanup')
      .set(authHeader(operatorToken))
      .send(cleanupCommand)
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({
        status: 'NOTHING_TO_CLEAN',
        activityRecordsDeleted: 0,
        metricResultsDeleted: 0,
        reportsDeleted: 0,
      }));
    await expect(prisma.activityData.findUnique({
      where: { id: legitimate.id },
    })).resolves.toMatchObject({ id: legitimate.id });
    await expect(prisma.report.count({
      where: {
        organizationId: legacyUser.organizationId,
        title: GOLDEN_SAMPLE_REPORT_TITLE,
      },
    })).resolves.toBe(0);
    await provision(legacyUser.organization, legacyUser.id)
      .expect(201)
      .expect(({ body }) => expect(body.status).toBe('PROVISIONED'));

    await expect(prisma.activityData.count({
      where: { organizationId: customerUser.organizationId },
    })).resolves.toBe(0);
    await expect(prisma.activityData.count({
      where: {
        organizationId: demoUser.organizationId,
        sourceReference: GOLDEN_SAMPLE_SOURCE_FILE,
      },
    })).resolves.toBe(10);
  });
});

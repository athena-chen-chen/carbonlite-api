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

describe('Transactional customer provisioning (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('customer-provisioning');
  const password = 'Fictional-Test-Only!2026';

  beforeAll(async () => {
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
    process.env.DEMO_RESET_ENABLED = 'true';
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS customer_provisioning_test_fail ON "Organization"',
    );
    await prisma.$executeRawUnsafe(
      'DROP FUNCTION IF EXISTS customer_provisioning_test_fail_update()',
    );
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('authorizes, rolls back, retries, and idempotently provisions only A', async () => {
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} Organization A`,
      email: `admin-a-${testRunId}@carbonlite-e2e.test`,
      password,
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} Organization B`,
      email: `admin-b-${testRunId}@carbonlite-e2e.test`,
      password,
    });
    const operator = await createTestUser(app, {
      organizationName: `${testRunId} Platform Operations`,
      email: `operator-${testRunId}@carbonlite-e2e.test`,
      password,
    });

    await prisma.organization.update({
      where: { id: userA.user.organizationId },
      data: {
        customerStatus: 'PILOT',
        allowDemoFactorsForCalculations: true,
      },
    });
    await prisma.user.update({
      where: { id: userA.user.id },
      data: {
        accountType: 'PILOT_REVIEWER',
        accountExpiresAt: new Date(Date.now() + 86_400_000),
        passwordSetupRequired: true,
        passwordSetupTokenHash: `${testRunId}-invite-hash`,
        passwordSetupTokenExpiresAt: new Date(Date.now() + 43_200_000),
      },
    });
    await prisma.membership.createMany({
      data: [
        {
          userId: userA.user.id,
          organizationId: userA.user.organizationId,
          role: 'ADMIN',
        },
        {
          userId: userB.user.id,
          organizationId: userB.user.organizationId,
          role: 'OWNER',
        },
      ],
    });
    await prisma.user.update({
      where: { id: operator.user.id },
      data: { role: 'ADMIN' },
    });

    const tokenA = await loginAndGetToken(app, userA.user.email, password);
    const tokenB = await loginAndGetToken(app, userB.user.email, password);
    const operatorToken = await loginAndGetToken(app, operator.user.email, password);
    const organizationA = await prisma.organization.findUniqueOrThrow({
      where: { id: userA.user.organizationId },
    });
    const organizationBBefore = await prisma.organization.findUniqueOrThrow({
      where: { id: userB.user.organizationId },
      include: { memberships: true, users: true },
    });
    const command = {
      organizationId: organizationA.id,
      confirmationOrganizationId: organizationA.id,
      confirmationOrganizationSlug: organizationA.slug,
      primaryAdminUserId: userA.user.id,
      confirmProvision: true,
    };

    await request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/paid-pilot')
      .set(authHeader(tokenB))
      .send(command)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/paid-pilot')
      .set(authHeader(tokenA))
      .send({ ...command, organizationId: userB.user.organizationId })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/paid-pilot')
      .set(authHeader(operatorToken))
      .send({ ...command, confirmationOrganizationId: userB.user.organizationId })
      .expect(400);

    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION customer_provisioning_test_fail_update()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."customerStatus" = 'ACTIVE' AND OLD.id = '${organizationA.id}' THEN
          RAISE EXCEPTION 'controlled provisioning failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER customer_provisioning_test_fail
      BEFORE UPDATE ON "Organization"
      FOR EACH ROW EXECUTE FUNCTION customer_provisioning_test_fail_update()
    `);
    await request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/paid-pilot')
      .set(authHeader(operatorToken))
      .send(command)
      .expect(500);
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER customer_provisioning_test_fail ON "Organization"',
    );
    await prisma.$executeRawUnsafe(
      'DROP FUNCTION customer_provisioning_test_fail_update()',
    );

    const rolledBackOrganization = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationA.id },
    });
    const rolledBackUser = await prisma.user.findUniqueOrThrow({
      where: { id: userA.user.id },
    });
    const rolledBackMembership = await prisma.membership.findUniqueOrThrow({
      where: {
        userId_organizationId: {
          userId: userA.user.id,
          organizationId: organizationA.id,
        },
      },
    });
    expect(rolledBackOrganization).toMatchObject({
      customerStatus: 'PILOT',
      provisionedAt: null,
      allowDemoFactorsForCalculations: true,
    });
    expect(rolledBackUser).toMatchObject({ accountType: 'PILOT_REVIEWER' });
    expect(rolledBackMembership.role).toBe('ADMIN');

    const provisioned = await request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/paid-pilot')
      .set(authHeader(operatorToken))
      .send(command)
      .expect(201);
    expect(provisioned.body).toEqual(
      expect.objectContaining({
        organizationId: organizationA.id,
        primaryAdminUserId: userA.user.id,
        status: 'PROVISIONED',
        alreadyProvisioned: false,
        warnings: [],
      }),
    );

    const retry = await request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/paid-pilot')
      .set(authHeader(operatorToken))
      .send(command)
      .expect(201);
    expect(retry.body).toEqual(
      expect.objectContaining({
        status: 'ALREADY_PROVISIONED',
        alreadyProvisioned: true,
        provisionedAt: provisioned.body.provisionedAt,
      }),
    );

    const finalOrganization = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationA.id },
    });
    const finalUser = await prisma.user.findUniqueOrThrow({
      where: { id: userA.user.id },
    });
    const finalMemberships = await prisma.membership.findMany({
      where: { userId: userA.user.id, organizationId: organizationA.id },
    });
    expect(finalOrganization).toMatchObject({
      customerStatus: 'ACTIVE',
      allowDemoFactorsForCalculations: false,
      isActive: true,
    });
    expect(finalOrganization.provisionedAt).not.toBeNull();
    expect(finalUser).toMatchObject({
      accountType: 'CUSTOMER',
      accountExpiresAt: null,
      passwordSetupRequired: true,
      passwordSetupTokenHash: `${testRunId}-invite-hash`,
    });
    expect(finalMemberships).toHaveLength(1);
    expect(finalMemberships[0].role).toBe('OWNER');

    await prisma.user.update({
      where: { id: userA.user.id },
      data: {
        passwordSetupRequired: false,
        passwordSetupTokenUsedAt: new Date(),
      },
    });
    const refreshedTokenA = await loginAndGetToken(app, userA.user.email, password);
    await prisma.conversionFactor.create({
      data: {
        organizationId: organizationA.id,
        name: `${testRunId} demo-only factor`,
        type: 'EMISSION',
        activityType: 'DIESEL',
        unit: 'liters',
        factorValue: 99,
        resultUnit: 'kgCO2e',
        confidenceLevel: 'DEMO',
        verificationStatus: 'DRAFT',
        verified: false,
        isDefault: true,
      },
    });
    const activity = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(refreshedTokenA))
      .send({
        activityType: 'DIESEL',
        recordDate: '2026-01-01',
        quantity: 1,
        unit: 'liters',
        sourceType: 'MANUAL',
      })
      .expect(201);
    const calculation = await request(app.getHttpServer())
      .post('/api/metrics/calculate')
      .set(authHeader(refreshedTokenA))
      .send({
        activityDataIds: [activity.body.id],
        metricTypes: ['CARBON_EMISSION'],
      })
      .expect(201);
    expect(calculation.body).toEqual({ items: [], count: 0 });
    expect(
      await prisma.activityData.findUniqueOrThrow({ where: { id: activity.body.id } }),
    ).toMatchObject({
      calculationStatus: 'MISSING_FACTOR',
      calculatedEmissionsKgCO2e: null,
    });

    await request(app.getHttpServer())
      .post('/api/admin/demo-data/reset')
      .set(authHeader(refreshedTokenA))
      .send({ confirmation: 'RESET DEMO DATA' })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/admin/workspace-erasure/dry-run')
      .set(authHeader(operatorToken))
      .send({ organizationId: organizationA.id })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toEqual(
          expect.objectContaining({ status: 'DRY_RUN', dataDeleted: false }),
        );
      });

    expect(
      await prisma.organization.findUniqueOrThrow({
        where: { id: userB.user.organizationId },
        include: { memberships: true, users: true },
      }),
    ).toEqual(organizationBBefore);
  });
});

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SYNTHETIC_ONLY_PILOT_NOTICE } from '../src/common/policies/synthetic-only-pilot';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import {
  authHeader,
  cleanupTestData,
  createTestUser,
  uniqueTestId,
} from './helpers/factories';

describe('Customer pilot safeguards (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const run = uniqueTestId('customer-safeguards');
  const password = 'Fictional-Test-Only!2026';
  const globalFactorId = `${run}-global-factor`;
  const previousPublicRegistration = process.env.PUBLIC_REGISTRATION_ENABLED;

  beforeAll(async () => {
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
    const setup = await createE2eApp();
    app = setup.app;
    prisma = setup.prisma;
  });

  afterAll(async () => {
    let teardownError: unknown;
    try {
      if (prisma) {
        await prisma.conversionFactor.deleteMany({
          where: { id: globalFactorId },
        });
        await cleanupTestData(prisma, run);
      }
    } catch (error) {
      teardownError = error;
    }
    try {
      if (app) await app.close();
    } catch (error) {
      teardownError ??= error;
    }
    if (previousPublicRegistration === undefined) {
      delete process.env.PUBLIC_REGISTRATION_ENABLED;
    } else {
      process.env.PUBLIC_REGISTRATION_ENABLED = previousPublicRegistration;
    }
    if (teardownError) throw teardownError;
  });

  it('provides a repeatable platform-admin preflight without secrets or side effects', async () => {
    const customer = await createTestUser(app, {
      organizationName: `${run} Preflight Customer`,
      email: `preflight-${run}@carbonlite-e2e.test`,
      password,
    });
    const platform = await createTestUser(app, {
      organizationName: `${run} Preflight Platform`,
      email: `platform-preflight-${run}@carbonlite-e2e.test`,
      password,
    });
    await prisma.user.update({
      where: { id: platform.user.id },
      data: { role: 'ADMIN', accountType: 'INTERNAL' },
    });
    await prisma.user.update({
      where: { id: customer.user.id },
      data: {
        accountType: 'PILOT_REVIEWER',
        passwordSetupRequired: true,
        passwordSetupTokenHash: `${run}-secret-token-hash`,
        passwordSetupTokenExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.membership.create({
      data: {
        userId: customer.user.id,
        organizationId: customer.user.organizationId,
        role: 'VIEWER',
      },
    });
    await prisma.organizationQuota.create({
      data: {
        organizationId: customer.user.organizationId,
        enabled: true,
        uploadLimit: 20,
        dailyUploadLimit: 3,
        maxFileSizeBytes: 10 * 1024 * 1024,
        maxConcurrentExtractions: 1,
        maxImportRows: 500,
      },
    });
    await prisma.organizationAiAuthorization.create({
      data: {
        organizationId: customer.user.organizationId,
        status: 'DISABLED',
        consentVersion: 'synthetic-only-v1',
        provider: 'OPENAI',
        processingScope: 'DOCUMENT_EXTRACTION',
        evidenceReference: 'evidence://synthetic/customer-declined',
        authorizedRepresentativeReference: 'synthetic-customer',
        verifiedById: platform.user.id,
        verifiedAt: new Date(),
        effectiveAt: new Date(),
      },
    });

    const organizationBefore = await prisma.organization.findUniqueOrThrow({
      where: { id: customer.user.organizationId },
    });
    const userBefore = await prisma.user.findUniqueOrThrow({
      where: { id: customer.user.id },
    });
    const auditCountBefore = await prisma.auditLog.count({
      where: { organizationId: customer.user.organizationId },
    });
    const endpoint = `/api/admin/customer-provisioning/preflight?email=${encodeURIComponent(
      customer.user.email.toUpperCase(),
    )}`;

    await request(app.getHttpServer())
      .get(endpoint)
      .set(authHeader(customer.accessToken))
      .expect(403);

    const first = await request(app.getHttpServer())
      .get(endpoint)
      .set(authHeader(platform.accessToken))
      .expect(200);
    const second = await request(app.getHttpServer())
      .get(endpoint)
      .set(authHeader(platform.accessToken))
      .expect(200);

    expect(second.body).toEqual(first.body);
    expect(first.body).toMatchObject({
      lookup: { normalizedEmail: customer.user.email },
      user: {
        exists: true,
        id: customer.user.id,
        normalizedEmail: customer.user.email,
        platformRole: 'USER',
        accountType: 'PILOT_REVIEWER',
        isActive: true,
        passwordSetupRequired: true,
        invitationStatus: 'pending',
        organizationId: customer.user.organizationId,
        membershipRole: 'VIEWER',
      },
      organization: {
        id: customer.user.organizationId,
        customerStatus: 'PENDING',
        isActive: true,
        allowDemoFactorsForCalculations: false,
        counts: {
          activityData: 0,
          reports: 0,
          documents: 0,
          goldenSampleArtifacts: 0,
          memberships: 1,
        },
        quota: {
          enabled: true,
          uploadLimit: 20,
          dailyUploadLimit: 3,
          maxFileSizeBytes: 10 * 1024 * 1024,
          maxConcurrentExtractions: 1,
          maxImportRows: 500,
        },
        aiAuthorization: {
          status: 'DISABLED',
          provider: 'OPENAI',
          processingScope: 'DOCUMENT_EXTRACTION',
        },
      },
    });
    expect(JSON.stringify(first.body)).not.toContain('passwordSetupToken');
    expect(JSON.stringify(first.body)).not.toContain(`${run}-secret-token-hash`);
    await expect(
      prisma.organization.findUniqueOrThrow({
        where: { id: customer.user.organizationId },
      }),
    ).resolves.toEqual(organizationBefore);
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: customer.user.id } }),
    ).resolves.toEqual(userBefore);
    await expect(
      prisma.auditLog.count({
        where: { organizationId: customer.user.organizationId },
      }),
    ).resolves.toBe(auditCountBefore);

    await request(app.getHttpServer())
      .get(`/api/admin/customer-provisioning/preflight?email=missing-${run}@carbonlite-e2e.test`)
      .set(authHeader(platform.accessToken))
      .expect(200)
      .expect(({ body }) => {
        expect(body.user).toEqual({
          exists: false,
          normalizedEmail: `missing-${run}@carbonlite-e2e.test`,
        });
        expect(body.organization).toBeNull();
      });
  });

  it('suspends only the confirmed ACTIVE CUSTOMER and immediately blocks login and existing JWTs', async () => {
    const customer = await createTestUser(app, {
      organizationName: `${run} Suspension Customer`,
      email: `suspension-${run}@carbonlite-e2e.test`,
      password,
    });
    const unrelated = await createTestUser(app, {
      organizationName: `${run} Suspension Unrelated`,
      email: `unrelated-${run}@carbonlite-e2e.test`,
      password,
    });
    const platform = await createTestUser(app, {
      organizationName: `${run} Suspension Platform`,
      email: `platform-suspension-${run}@carbonlite-e2e.test`,
      password,
    });
    await prisma.user.update({
      where: { id: platform.user.id },
      data: { role: 'ADMIN', accountType: 'INTERNAL' },
    });
    await prisma.user.update({
      where: { id: customer.user.id },
      data: { accountType: 'CUSTOMER' },
    });
    await prisma.organization.update({
      where: { id: customer.user.organizationId },
      data: { customerStatus: 'ACTIVE', provisionedAt: new Date() },
    });
    await prisma.membership.create({
      data: {
        userId: customer.user.id,
        organizationId: customer.user.organizationId,
        role: 'OWNER',
      },
    });
    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: customer.user.organizationId },
    });
    const unrelatedBefore = await prisma.organization.findUniqueOrThrow({
      where: { id: unrelated.user.organizationId },
    });
    const activity = await prisma.activityData.create({
      data: {
        organizationId: organization.id,
        activityType: 'DIESEL',
        recordDate: new Date('2026-11-01T00:00:00.000Z'),
        quantity: 1,
        unit: 'L',
        sourceType: 'MANUAL',
      },
    });
    const report = await prisma.report.create({
      data: {
        organizationId: organization.id,
        title: `${run} retained report`,
        createdById: customer.user.id,
      },
    });
    const document = await prisma.document.create({
      data: {
        organizationId: organization.id,
        uploadedById: customer.user.id,
        fileName: `${run}-retained.pdf`,
        fileUrl: `/uploads/${run}-retained.pdf`,
        mimeType: 'application/pdf',
        type: 'PDF',
      },
    });
    await prisma.conversionFactor.create({
      data: {
        id: globalFactorId,
        organizationId: null,
        name: `${run} retained global factor`,
        type: 'EMISSION',
        activityType: 'DIESEL',
        unit: 'L',
        factorValue: 1,
        resultUnit: 'kgCO2e',
      },
    });
    const globalFactorBefore = await prisma.conversionFactor.findUniqueOrThrow({
      where: { id: globalFactorId },
    });

    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set(authHeader(customer.accessToken))
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: customer.user.email, password })
      .expect(201)
      .expect(({ body }) => {
        expect(body.usageNotice).toBe(SYNTHETIC_ONLY_PILOT_NOTICE);
      });

    const command = {
      organizationId: organization.id,
      confirmationOrganizationId: organization.id,
      confirmationOrganizationSlug: organization.slug,
      confirmSuspend: true,
    };
    await request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/suspend')
      .set(authHeader(unrelated.accessToken))
      .send(command)
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/suspend')
      .set(authHeader(platform.accessToken))
      .send(command)
      .expect(201)
      .expect(({ body }) => {
        expect(body).toEqual({
          organizationId: organization.id,
          status: 'SUSPENDED',
          suspended: true,
        });
      });

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: customer.user.email, password })
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set(authHeader(customer.accessToken))
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/suspend')
      .set(authHeader(platform.accessToken))
      .send(command)
      .expect(201)
      .expect(({ body }) => expect(body.status).toBe('ALREADY_SUSPENDED'));

    await expect(
      prisma.organization.findUniqueOrThrow({ where: { id: organization.id } }),
    ).resolves.toMatchObject({ customerStatus: 'SUSPENDED', isActive: true });
    await expect(
      prisma.activityData.findUnique({ where: { id: activity.id } }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.report.findUnique({ where: { id: report.id } }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.document.findUnique({ where: { id: document.id } }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.conversionFactor.findUniqueOrThrow({ where: { id: globalFactorId } }),
    ).resolves.toEqual(globalFactorBefore);
    await expect(
      prisma.organization.findUniqueOrThrow({
        where: { id: unrelated.user.organizationId },
      }),
    ).resolves.toEqual(unrelatedBefore);
    await expect(
      prisma.auditLog.count({
        where: {
          organizationId: organization.id,
          action: 'CUSTOMER_ORGANIZATION_SUSPENDED',
        },
      }),
    ).resolves.toBe(1);
  });
});

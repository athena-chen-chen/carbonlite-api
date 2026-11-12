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

describe('External customer safeguards (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const run = uniqueTestId('customer-safeguards');
  const password = 'Fictional-Test-Only!2026';
  const globalFactorId = `${run}-global-factor`;

  beforeAll(async () => {
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await prisma.conversionFactor.deleteMany({ where: { id: globalFactorId } });
    await cleanupTestData(prisma, run);
    await app.close();
  });

  it('keeps preflight platform-only, read-only, and free of secrets', async () => {
    const customer = await createTestUser(app, {
      organizationName: `${run} Customer`,
      email: `customer-${run}@carbonlite-e2e.test`,
      password,
    });
    const platform = await createTestUser(app, {
      organizationName: `${run} Platform`,
      email: `platform-${run}@carbonlite-e2e.test`,
      password,
    });
    await prisma.user.update({
      where: { id: platform.user.id },
      data: { role: 'ADMIN' },
    });
    await prisma.membership.upsert({
      where: {
        userId_organizationId: {
          userId: customer.user.id,
          organizationId: customer.user.organizationId,
        },
      },
      create: {
        userId: customer.user.id,
        organizationId: customer.user.organizationId,
        role: 'OWNER',
      },
      update: { role: 'OWNER' },
    });
    const customerToken = await loginAndGetToken(
      app,
      customer.user.email,
      password,
    );
    const platformToken = await loginAndGetToken(
      app,
      platform.user.email,
      password,
    );
    const before = await prisma.organization.findUniqueOrThrow({
      where: { id: customer.user.organizationId },
      include: { users: true, memberships: true },
    });
    const path = `/api/admin/customer-provisioning/preflight?email=${encodeURIComponent(customer.user.email)}`;

    await request(app.getHttpServer()).get(path).expect(401);
    await request(app.getHttpServer())
      .get(path)
      .set(authHeader(customerToken))
      .expect(403);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await request(app.getHttpServer())
        .get(path)
        .set(authHeader(platformToken))
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            lookup: { normalizedEmail: customer.user.email },
            user: {
              exists: true,
              id: customer.user.id,
              organizationId: customer.user.organizationId,
              membershipRole: 'OWNER',
            },
            organization: {
              id: customer.user.organizationId,
              counts: {
                activityData: 0,
                reports: 0,
                documents: 0,
                goldenSampleArtifacts: 0,
                memberships: 1,
              },
            },
          });
          const serialized = JSON.stringify(body).toLowerCase();
          expect(serialized).not.toContain('passwordhash');
          expect(serialized).not.toContain('passwordsetuptokenhash');
          expect(serialized).not.toContain('accesstoken');
        });
    }

    await expect(
      prisma.organization.findUniqueOrThrow({
        where: { id: customer.user.organizationId },
        include: { users: true, memberships: true },
      }),
    ).resolves.toEqual(before);
  });

  it('suspends one active customer, rejects fresh and stale auth, and retains data', async () => {
    const customer = await createTestUser(app, {
      organizationName: `${run} Suspend Target`,
      email: `suspend-${run}@carbonlite-e2e.test`,
      password,
    });
    const unrelated = await createTestUser(app, {
      organizationName: `${run} Unrelated`,
      email: `unrelated-${run}@carbonlite-e2e.test`,
      password,
    });
    const platform = await createTestUser(app, {
      organizationName: `${run} Suspend Platform`,
      email: `suspend-platform-${run}@carbonlite-e2e.test`,
      password,
    });
    await prisma.user.update({
      where: { id: platform.user.id },
      data: { role: 'ADMIN' },
    });
    await prisma.user.update({
      where: { id: customer.user.id },
      data: { accountType: 'CUSTOMER' },
    });
    const organization = await prisma.organization.update({
      where: { id: customer.user.organizationId },
      data: {
        customerStatus: 'ACTIVE',
        provisionedAt: new Date(),
        allowDemoFactorsForCalculations: false,
      },
    });
    await prisma.membership.upsert({
      where: {
        userId_organizationId: {
          userId: customer.user.id,
          organizationId: organization.id,
        },
      },
      create: {
        userId: customer.user.id,
        organizationId: organization.id,
        role: 'OWNER',
      },
      update: { role: 'OWNER' },
    });
    const customerToken = await loginAndGetToken(
      app,
      customer.user.email,
      password,
    );
    const unrelatedToken = await loginAndGetToken(
      app,
      unrelated.user.email,
      password,
    );
    const platformToken = await loginAndGetToken(
      app,
      platform.user.email,
      password,
    );
    await prisma.organizationQuota.create({
      data: {
        organizationId: organization.id,
        enabled: true,
        dailyUploadLimit: 3,
        maxConcurrentExtractions: 1,
      },
    });
    await prisma.organizationAiAuthorization.create({
      data: {
        organizationId: organization.id,
        status: 'ENABLED',
        consentVersion: 'synthetic-external-pilot-v1',
        provider: 'OPENAI',
        processingScope: 'DOCUMENT_EXTRACTION',
        evidenceReference: 'synthetic-evidence-reference',
        authorizedRepresentativeReference: 'synthetic-representative-reference',
        verifiedById: platform.user.id,
        verifiedAt: new Date(),
        effectiveAt: new Date(Date.now() - 1_000),
      },
    });
    const unrelatedBefore = await prisma.organization.findUniqueOrThrow({
      where: { id: unrelated.user.organizationId },
    });
    const activity = await prisma.activityData.create({
      data: {
        organizationId: organization.id,
        activityType: 'GASOLINE',
        recordDate: new Date('2026-01-01T00:00:00.000Z'),
        quantity: 1,
        unit: 'liters',
        sourceType: 'MANUAL',
      },
    });
    const report = await prisma.report.create({
      data: { organizationId: organization.id, title: `${run} retained report` },
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
    const command = {
      organizationId: organization.id,
      confirmationOrganizationId: organization.id,
      confirmationOrganizationSlug: organization.slug,
      confirmSuspend: true,
    };

    await request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/suspend')
      .set(authHeader(unrelatedToken))
      .send(command)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/suspend')
      .set(authHeader(platformToken))
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
      .set(authHeader(customerToken))
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/document-extraction/extract')
      .set(authHeader(customerToken))
      .send({ documentId: document.id })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/suspend')
      .set(authHeader(platformToken))
      .send(command)
      .expect(201)
      .expect(({ body }) => expect(body.status).toBe('ALREADY_SUSPENDED'));

    await expect(
      prisma.organization.findUniqueOrThrow({ where: { id: organization.id } }),
    ).resolves.toMatchObject({ customerStatus: 'SUSPENDED', isActive: true });
    await expect(prisma.activityData.findUnique({ where: { id: activity.id } })).resolves.not.toBeNull();
    await expect(prisma.report.findUnique({ where: { id: report.id } })).resolves.not.toBeNull();
    await expect(prisma.document.findUnique({ where: { id: document.id } })).resolves.not.toBeNull();
    await expect(prisma.organizationQuota.findUnique({
      where: { organizationId: organization.id },
    })).resolves.toMatchObject({ enabled: true, maxConcurrentExtractions: 1 });
    await expect(prisma.organizationAiAuthorization.findUnique({
      where: { organizationId: organization.id },
    })).resolves.toMatchObject({ status: 'ENABLED', provider: 'OPENAI' });
    await expect(prisma.organizationQuotaUsage.count({
      where: { organizationId: organization.id },
    })).resolves.toBe(0);
    await expect(prisma.aIJob.count({
      where: { organizationId: organization.id },
    })).resolves.toBe(0);
    await expect(prisma.conversionFactor.findUniqueOrThrow({ where: { id: globalFactorId } })).resolves.toEqual(globalFactorBefore);
    await expect(prisma.organization.findUniqueOrThrow({ where: { id: unrelated.user.organizationId } })).resolves.toEqual(unrelatedBefore);
    await expect(prisma.auditLog.count({
      where: {
        organizationId: organization.id,
        action: 'CUSTOMER_ORGANIZATION_SUSPENDED',
      },
    })).resolves.toBe(1);
  });
});

import { INestApplication } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import { AuditLogService } from '../src/audit-log/audit-log.service';
import {
  PLATFORM_ADMIN_ACCOUNT_TYPE,
  PLATFORM_ADMIN_BOOTSTRAP_ACTION,
  PlatformAdminBootstrapService,
} from '../src/auth/platform-admin-bootstrap.service';
import { createE2eApp } from './helpers/e2e-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { uniqueTestId } from './helpers/factories';

describe('first platform-admin bootstrap (disposable PostgreSQL e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: PlatformAdminBootstrapService;
  const testRunId = uniqueTestId('platform-admin-bootstrap');
  const email = `${testRunId}@carbonlite.invalid`;
  const password = 'Fictional-Test-Only!2026';
  const environmentName = 'carbonlite-e2e-bootstrap';
  let anchorOrganizationId: string;
  let organizationCountAfterAnchor: number;

  beforeAll(async () => {
    process.env.PUBLIC_REGISTRATION_ENABLED = 'false';
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;

    expect(
      await prisma.user.count({
        where: {
          role: UserRole.ADMIN,
          OR: [
            { accountType: null },
            { accountType: { not: 'PILOT_REVIEWER' } },
          ],
        },
      }),
    ).toBe(0);

    const anchor = await prisma.organization.create({
      data: {
        name: `${testRunId} Infrastructure Anchor`,
        slug: testRunId,
      },
    });
    anchorOrganizationId = anchor.id;
    organizationCountAfterAnchor = await prisma.organization.count();
    bootstrap = new PlatformAdminBootstrapService(
      prisma,
      new AuditLogService(prisma),
    );
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({
      where: { id: anchorOrganizationId },
    });
    await app.close();
  });

  it('bootstraps once, uses normal setup/login, and leaves customer state empty', async () => {
    const result = await bootstrap.bootstrap(
      {
        email,
        name: 'Synthetic RC Platform Administrator',
        anchorOrganizationId,
        confirmEnvironment: environmentName,
      },
      {
        ALLOW_PLATFORM_ADMIN_BOOTSTRAP: 'true',
        PLATFORM_ADMIN_BOOTSTRAP_ENVIRONMENT: environmentName,
      },
    );

    const persisted = await prisma.user.findUniqueOrThrow({
      where: { id: result.userId },
    });
    expect(persisted).toMatchObject({
      email,
      role: UserRole.ADMIN,
      accountType: PLATFORM_ADMIN_ACCOUNT_TYPE,
      organizationId: anchorOrganizationId,
      passwordHash: null,
      passwordSetupRequired: true,
      passwordSetupTokenUsedAt: null,
      isActive: true,
    });
    expect(persisted.passwordSetupTokenHash).not.toBe(result.setupToken);
    expect(persisted.passwordSetupTokenExpiresAt!.getTime()).toBeGreaterThan(
      Date.now(),
    );

    const setup = await request(app.getHttpServer())
      .post('/api/auth/set-password')
      .send({ token: result.setupToken, password })
      .expect(201);
    expect(setup.body.user).toMatchObject({
      id: result.userId,
      platformRole: UserRole.ADMIN,
      accountType: PLATFORM_ADMIN_ACCOUNT_TYPE,
      membershipRole: null,
    });
    expect(setup.body.accessToken).toEqual(expect.any(String));

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password })
      .expect(201);
    expect(login.body.user).toMatchObject({
      id: result.userId,
      platformRole: UserRole.ADMIN,
      accountType: PLATFORM_ADMIN_ACCOUNT_TYPE,
      membershipRole: null,
    });
    expect(login.body.accessToken).toEqual(expect.any(String));

    await expect(
      bootstrap.bootstrap(
        {
          email: `${testRunId}-second@carbonlite.invalid`,
          name: 'Second Synthetic Administrator',
          anchorOrganizationId,
          confirmEnvironment: environmentName,
        },
        {
          ALLOW_PLATFORM_ADMIN_BOOTSTRAP: 'true',
          PLATFORM_ADMIN_BOOTSTRAP_ENVIRONMENT: environmentName,
        },
      ),
    ).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_ALREADY_EXISTS' });

    expect(await prisma.user.count({ where: { role: UserRole.ADMIN } })).toBe(1);
    expect(await prisma.membership.count()).toBe(0);
    expect(await prisma.organization.count()).toBe(organizationCountAfterAnchor);
    expect(await prisma.organizationRealDataAuthorization.count()).toBe(0);
    expect(await prisma.organizationAiAuthorization.count()).toBe(0);
    expect(await prisma.realDataAuthorizationEvidence.count()).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { action: PLATFORM_ADMIN_BOOTSTRAP_ACTION },
      }),
    ).toBe(1);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: PLATFORM_ADMIN_BOOTSTRAP_ACTION },
    });
    const serializedAudit = JSON.stringify(audit);
    expect(serializedAudit).not.toContain(result.setupToken);
    expect(serializedAudit).not.toContain(password);
    expect(serializedAudit).not.toContain(login.body.accessToken);
  });
});

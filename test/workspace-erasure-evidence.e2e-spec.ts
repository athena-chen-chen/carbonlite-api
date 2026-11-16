import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { assertSafeTestDatabaseTarget } from './helpers/database-safety';
import { createE2eApp } from './helpers/e2e-app';
import {
  authHeader,
  cleanupTestData,
  createTestUser,
  uniqueTestId,
} from './helpers/factories';

describe('workspace erasure compliance evidence (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let previousRegistration: string | undefined;
  let previousEvidenceVersion: string | undefined;
  let previousEvidenceKeyring: string | undefined;

  const run = uniqueTestId('workspace-erasure-evidence');
  const v1Key = Buffer.alloc(32, 31).toString('base64');
  const v2Key = Buffer.alloc(32, 32).toString('base64');
  const evidenceDecisionIds: string[] = [];

  beforeAll(async () => {
    assertSafeTestDatabaseTarget();
    previousRegistration = process.env.PUBLIC_REGISTRATION_ENABLED;
    previousEvidenceVersion = process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION;
    previousEvidenceKeyring = process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING;
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
    process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION = 'e2e-v1';
    process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING = JSON.stringify([
      { version: 'e2e-v1', key: `base64:${v1Key}` },
    ]);
    const setup = await createE2eApp();
    app = setup.app;
    prisma = setup.prisma;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.realDataAuthorizationEvidence.deleteMany({
        where: { authorizationDecisionId: { in: evidenceDecisionIds } },
      });
      await cleanupTestData(prisma, run);
    }
    if (app) await app.close();
    if (previousRegistration === undefined) delete process.env.PUBLIC_REGISTRATION_ENABLED;
    else process.env.PUBLIC_REGISTRATION_ENABLED = previousRegistration;
    if (previousEvidenceVersion === undefined) delete process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION;
    else process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION = previousEvidenceVersion;
    if (previousEvidenceKeyring === undefined) delete process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING;
    else process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING = previousEvidenceKeyring;
  });

  it('marks every revision across retained key versions and leaves another tenant untouched', async () => {
    const target = await createTestUser(app, {
      organizationName: `${run} target`,
      email: `target-${run}@carbonlite-e2e.test`,
    });
    const other = await createTestUser(app, {
      organizationName: `${run} other`,
      email: `other-${run}@carbonlite-e2e.test`,
    });
    const platform = await createTestUser(app, {
      organizationName: `${run} platform`,
      email: `platform-${run}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: platform.user.id },
      data: { role: 'ADMIN', accountType: 'INTERNAL' },
    });

    for (const customer of [target, other]) {
      await prisma.organization.update({
        where: { id: customer.user.organizationId },
        data: {
          customerStatus: 'ACTIVE',
          provisionedAt: new Date(),
          allowDemoFactorsForCalculations: false,
        },
      });
      await prisma.user.update({
        where: { id: customer.user.id },
        data: { accountType: 'CUSTOMER', isActive: true },
      });
      await prisma.membership.upsert({
        where: {
          userId_organizationId: {
            organizationId: customer.user.organizationId,
            userId: customer.user.id,
          },
        },
        create: {
          organizationId: customer.user.organizationId,
          userId: customer.user.id,
          role: 'OWNER',
        },
        update: { role: 'OWNER' },
      });
      await prisma.organizationQuota.create({
        data: { organizationId: customer.user.organizationId, enabled: true },
      });
    }

    const platformHeader = authHeader(platform.accessToken);
    const targetOrganization = await prisma.organization.findUniqueOrThrow({
      where: { id: target.user.organizationId },
    });
    const otherOrganization = await prisma.organization.findUniqueOrThrow({
      where: { id: other.user.organizationId },
    });

    const approve = async (
      organization: { id: string; slug: string },
      label: string,
    ) => {
      const response = await request(app.getHttpServer())
        .put(`/api/admin/organizations/${organization.id}/real-data-authorization`)
        .set(platformHeader)
        .send({
          organizationId: organization.id,
          confirmationOrganizationId: organization.id,
          confirmationOrganizationSlug: organization.slug,
          confirmRealDataApproval: true,
          policyVersion: 'CARBONLITE_ALLOWED_DATA_POLICY_V0_2',
          agreementEvidenceReference: `agreement://${label}`,
          allowedDataScopeReference: `scope://${label}`,
          privacySecurityReadinessReference: `readiness://${label}`,
          effectiveAt: '2026-01-01T00:00:00.000Z',
          reviewDueAt: '2099-01-01T00:00:00.000Z',
        })
        .expect(200);
      evidenceDecisionIds.push(response.body.authorization.decisionId);
      return response.body.authorization.decisionId as string;
    };
    const withdraw = (organization: { id: string; slug: string }, label: string) =>
      request(app.getHttpServer())
        .post(`/api/admin/organizations/${organization.id}/real-data-authorization/withdraw`)
        .set(platformHeader)
        .send({
          organizationId: organization.id,
          confirmationOrganizationId: organization.id,
          confirmationOrganizationSlug: organization.slug,
          confirmWithdrawal: true,
          withdrawalReason: `WITHDRAW_${label}`,
        })
        .expect(201);

    const targetV1Decision = await approve(targetOrganization, 'target-r1');
    await withdraw(targetOrganization, 'TARGET_R1');
    const otherV1Decision = await approve(otherOrganization, 'other-r1');
    await withdraw(otherOrganization, 'OTHER_R1');

    process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION = 'e2e-v2';
    process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING = JSON.stringify([
      { version: 'e2e-v1', key: `base64:${v1Key}` },
      { version: 'e2e-v2', key: `base64:${v2Key}` },
    ]);

    const targetV2Decision = await approve(targetOrganization, 'target-r2');
    await withdraw(targetOrganization, 'TARGET_R2');
    const otherV2Decision = await approve(otherOrganization, 'other-r2');
    await withdraw(otherOrganization, 'OTHER_R2');

    const targetDecisionIds = [targetV1Decision, targetV2Decision];
    const otherDecisionIds = [otherV1Decision, otherV2Decision];
    const targetBefore = await prisma.realDataAuthorizationEvidence.findMany({
      where: { authorizationDecisionId: { in: targetDecisionIds } },
      orderBy: { createdAt: 'asc' },
    });
    const otherBefore = await prisma.realDataAuthorizationEvidence.findMany({
      where: { authorizationDecisionId: { in: otherDecisionIds } },
      orderBy: { createdAt: 'asc' },
    });
    expect(targetBefore).toHaveLength(4);
    expect(otherBefore).toHaveLength(4);
    const immutableTargetEvidence = targetBefore.map(row => ({
      id: row.id,
      hmacKeyVersion: row.hmacKeyVersion,
      organizationIdHash: row.organizationIdHash,
      approvalRevision: row.approvalRevision,
      decision: row.decision,
    }));

    await prisma.organization.update({
      where: { id: targetOrganization.id },
      data: { customerStatus: 'SUSPENDED' },
    });
    const erasePayload = {
      organizationId: targetOrganization.id,
      confirmationOrganizationId: targetOrganization.id,
      confirmationOrganizationSlug: targetOrganization.slug,
      confirmErase: true,
    };
    await request(app.getHttpServer())
      .post('/api/admin/workspace-erasure/erase')
      .set(platformHeader)
      .send(erasePayload)
      .expect(201)
      .expect(({ body }) => expect(body.status).toBe('ERASED'));

    const targetAfter = await prisma.realDataAuthorizationEvidence.findMany({
      where: { authorizationDecisionId: { in: targetDecisionIds } },
      orderBy: { createdAt: 'asc' },
    });
    const otherAfter = await prisma.realDataAuthorizationEvidence.findMany({
      where: { authorizationDecisionId: { in: otherDecisionIds } },
      orderBy: { createdAt: 'asc' },
    });
    expect(targetAfter).toHaveLength(4);
    expect(new Set(targetAfter.map(row => row.workspaceErasedAt?.toISOString())).size).toBe(1);
    expect(targetAfter.every(row => row.workspaceErasedAt !== null)).toBe(true);
    expect(targetAfter.map(row => ({
      id: row.id,
      hmacKeyVersion: row.hmacKeyVersion,
      organizationIdHash: row.organizationIdHash,
      approvalRevision: row.approvalRevision,
      decision: row.decision,
    }))).toEqual(immutableTargetEvidence);
    expect(targetAfter.filter(row => row.hmacKeyVersion === 'e2e-v1')).toHaveLength(2);
    expect(targetAfter.filter(row => row.hmacKeyVersion === 'e2e-v2')).toHaveLength(2);
    expect(otherAfter).toEqual(otherBefore);
    expect(await prisma.organization.findUnique({ where: { id: targetOrganization.id } })).toBeNull();
    expect(await prisma.activityData.count({ where: { organizationId: targetOrganization.id } })).toBe(0);
    expect(await prisma.document.count({ where: { organizationId: targetOrganization.id } })).toBe(0);

    const firstErasureTimestamp = targetAfter[0].workspaceErasedAt;
    await request(app.getHttpServer())
      .post('/api/admin/workspace-erasure/erase')
      .set(platformHeader)
      .send(erasePayload)
      .expect(201)
      .expect(({ body }) => expect(body.status).toBe('ALREADY_ERASED'));
    const targetAfterIdempotentRetry = await prisma.realDataAuthorizationEvidence.findMany({
      where: { authorizationDecisionId: { in: targetDecisionIds } },
    });
    expect(targetAfterIdempotentRetry.every(row =>
      row.workspaceErasedAt?.getTime() === firstErasureTimestamp?.getTime(),
    )).toBe(true);
  });
});

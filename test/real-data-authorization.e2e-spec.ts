import { INestApplication } from '@nestjs/common';
import { AiAuthorizedDataMode } from '@prisma/client';
import request from 'supertest';
import { AiAuthorizationService } from '../src/ai-authorization/ai-authorization.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import { authHeader, cleanupTestData, createTestUser, uniqueTestId } from './helpers/factories';
import { assertSafeTestDatabaseTarget } from './helpers/database-safety';

describe('organization real-data authorization gate', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let previousEvidenceVersion: string | undefined;
  let previousEvidenceKeyring: string | undefined;
  const evidenceKey = Buffer.alloc(32, 9).toString('base64');
  const run = uniqueTestId('real-data-gate');
  const evidenceDecisionIds: string[] = [];

  beforeAll(async () => {
    assertSafeTestDatabaseTarget();
    previousEvidenceVersion = process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION;
    previousEvidenceKeyring = process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING;
    process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION = 'e2e-v1';
    process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING = JSON.stringify([
      { version: 'e2e-v1', key: `base64:${evidenceKey}` },
    ]);
    const setup = await createE2eApp();
    app = setup.app;
    prisma = setup.prisma;
  });

  afterAll(async () => {
    if (prisma) {
      await cleanupTestData(prisma, run);
      await prisma.realDataAuthorizationEvidence.deleteMany({
        where: { authorizationDecisionId: { in: evidenceDecisionIds } },
      });
    }
    if (app) await app.close();
    if (previousEvidenceVersion === undefined) delete process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION;
    else process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION = previousEvidenceVersion;
    if (previousEvidenceKeyring === undefined) delete process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING;
    else process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING = previousEvidenceKeyring;
  });

  it('is fail-closed, platform-admin controlled, revision-bound, and tenant isolated', async () => {
    const customer = await createTestUser(app, {
      organizationName: `${run} customer`,
      email: `${uniqueTestId(run)}@carbonlite-e2e.test`,
      factorProfile: 'reviewed',
    });
    const other = await createTestUser(app, {
      organizationName: `${run} other`,
      email: `${uniqueTestId(run)}@carbonlite-e2e.test`,
    });
    const platform = await createTestUser(app, {
      organizationName: `${run} platform`,
      email: `${uniqueTestId(run)}@carbonlite-e2e.test`,
    });
    await prisma.user.update({ where: { id: platform.user.id }, data: { role: 'ADMIN', accountType: 'INTERNAL' } });
    await prisma.organization.update({
      where: { id: customer.user.organizationId },
      data: { customerStatus: 'ACTIVE', provisionedAt: new Date() },
    });
    await prisma.user.update({
      where: { id: customer.user.id },
      data: { accountType: 'CUSTOMER', isActive: true },
    });
    await prisma.membership.upsert({
      where: { userId_organizationId: { organizationId: customer.user.organizationId, userId: customer.user.id } },
      create: { organizationId: customer.user.organizationId, userId: customer.user.id, role: 'OWNER' },
      update: { role: 'OWNER' },
    });
    await prisma.organizationQuota.create({
      data: {
        organizationId: customer.user.organizationId,
        enabled: true,
        periodDays: 28,
        uploadLimit: 20,
        dailyUploadLimit: 3,
        maxFileSizeBytes: 10_485_760,
        maxConcurrentExtractions: 1,
        maxImportRows: 500,
      },
    });
    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: customer.user.organizationId },
    });
    const endpoint = `/api/admin/organizations/${organization.id}/real-data-authorization`;

    await request(app.getHttpServer())
      .get('/api/real-data-authorization/status')
      .set(authHeader(customer.accessToken))
      .expect(200)
      .expect(({ body, text }) => {
        expect(body).toMatchObject({ effectiveMode: 'SYNTHETIC_ONLY', configuredStatus: 'NOT_CONFIGURED' });
        expect(text).not.toContain('Evidence');
      });

    await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(customer.accessToken))
      .send({ activityType: 'DIESEL', quantity: 1, unit: 'L', recordDate: '2026-11-13', sourceType: 'MANUAL' })
      .expect(201);

    const approval = {
      organizationId: organization.id,
      confirmationOrganizationId: organization.id,
      confirmationOrganizationSlug: organization.slug,
      confirmRealDataApproval: true,
      policyVersion: '0.2',
      agreementEvidenceReference: 'agreement://opaque-e2e-reference',
      allowedDataScopeReference: 'allowed-data://policy-v0.2',
      privacySecurityReadinessReference: 'readiness://opaque-e2e-reference',
      effectiveAt: '2026-11-13T00:00:00.000Z',
      reviewDueAt: '2027-01-01T00:00:00.000Z',
    };
    await request(app.getHttpServer()).put(endpoint).set(authHeader(customer.accessToken)).send(approval).expect(403);
    await request(app.getHttpServer()).put(endpoint).set(authHeader(other.accessToken)).send(approval).expect(403);
    const approved = await request(app.getHttpServer())
      .put(endpoint)
      .set(authHeader(platform.accessToken))
      .send(approval)
      .expect(200);
    expect(approved.body).toMatchObject({ result: 'APPROVED', authorization: { status: 'REAL_DATA_APPROVED', approvalRevision: 1 } });
    evidenceDecisionIds.push(approved.body.authorization.decisionId);

    await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(customer.accessToken))
      .send({ activityType: 'DIESEL', quantity: 1, unit: 'L', recordDate: '2026-11-13', sourceType: 'MANUAL' })
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('DATA_MODE_REQUIRED'));
    await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(customer.accessToken))
      .set('X-CarbonLite-Data-Mode', 'REAL_CUSTOMER_DATA')
      .send({ activityType: 'DIESEL', quantity: 1, unit: 'L', recordDate: '2026-11-13', sourceType: 'MANUAL' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(other.accessToken))
      .set('X-CarbonLite-Data-Mode', 'REAL_CUSTOMER_DATA')
      .send({ activityType: 'DIESEL', quantity: 1, unit: 'L', recordDate: '2026-11-13', sourceType: 'MANUAL' })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('REAL_DATA_NOT_AUTHORIZED'));

    const aiEndpoint = `/api/admin/organizations/${organization.id}/ai-authorization`;
    const aiBase = {
      status: 'ENABLED',
      consentVersion: 'real-data-ai-v1',
      provider: 'OPENAI',
      processingScope: 'DOCUMENT_EXTRACTION',
      evidenceReference: 'ai-evidence://opaque-e2e-reference',
      authorizedRepresentativeReference: 'representative://opaque-e2e-reference',
      effectiveAt: '2026-11-13T00:00:00.000Z',
    };
    await request(app.getHttpServer())
      .put(aiEndpoint)
      .set(authHeader(platform.accessToken))
      .send({ ...aiBase, authorizedDataMode: 'SYNTHETIC_TEST_ONLY' })
      .expect(200);
    await expect(app.get(AiAuthorizationService).assertProviderRequestAllowed(
      organization.id, 'OPENAI', 'DOCUMENT_EXTRACTION', 'REAL_CUSTOMER_DATA',
    )).rejects.toMatchObject({ status: 403 });
    await request(app.getHttpServer())
      .put(aiEndpoint)
      .set(authHeader(platform.accessToken))
      .send({ ...aiBase, authorizedDataMode: 'REAL_CUSTOMER_DATA', realDataApprovalRevision: 1 })
      .expect(200);
    await expect(app.get(AiAuthorizationService).assertProviderRequestAllowed(
      organization.id, 'OPENAI', 'DOCUMENT_EXTRACTION', 'REAL_CUSTOMER_DATA',
    )).resolves.toMatchObject({ authorizedDataMode: AiAuthorizedDataMode.REAL_CUSTOMER_DATA, realDataApprovalRevision: 1 });

    await request(app.getHttpServer())
      .post(`${endpoint}/withdraw`)
      .set(authHeader(platform.accessToken))
      .send({
        organizationId: organization.id,
        confirmationOrganizationId: organization.id,
        confirmationOrganizationSlug: organization.slug,
        confirmWithdrawal: true,
        withdrawalReason: 'PILOT_COMPLETE',
      })
      .expect(201)
      .expect(({ body }) => expect(body.authorization.status).toBe('WITHDRAWN'));
    await expect(prisma.organizationAiAuthorization.findUniqueOrThrow({ where: { organizationId: organization.id } }))
      .resolves.toMatchObject({ status: 'WITHDRAWN', authorizedDataMode: 'REAL_CUSTOMER_DATA' });

    const evidence = await prisma.realDataAuthorizationEvidence.findMany({
      where: { authorizationDecisionId: approved.body.authorization.decisionId },
    });
    expect(evidence).toHaveLength(2);
    expect(evidence.every(row => row.hmacKeyVersion === 'e2e-v1')).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain(organization.name);
    expect(JSON.stringify(evidence)).not.toContain(customer.user.email);
    expect(JSON.stringify(evidence)).not.toContain(evidenceKey);
    expect(JSON.stringify(approved.body)).not.toContain(evidenceKey);
  });
});

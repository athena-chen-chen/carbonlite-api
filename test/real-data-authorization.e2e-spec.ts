import * as XLSX from 'xlsx';
import { RealDataAuthorizationService } from '../src/real-data-authorization/real-data-authorization.service';
import { INestApplication } from '@nestjs/common';
import { AiAuthorizedDataMode } from '@prisma/client';
import request from 'supertest';
import { AiAuthorizationService } from '../src/ai-authorization/ai-authorization.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import { authHeader, cleanupTestData, createTestUser, uniqueTestId } from './helpers/factories';
import { assertSafeTestDatabaseTarget } from './helpers/database-safety';
import { RealDataEvidenceHmacKeyring } from '../src/real-data-authorization/real-data-evidence-hmac-keyring';
import { openai } from '../src/openai/openai.client';

describe('organization real-data authorization gate', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let previousEvidenceVersion: string | undefined;
  let previousEvidenceKeyring: string | undefined;
  let previousAdditionalEvidenceKeys: string | undefined;
  const evidenceKey = Buffer.alloc(32, 9).toString('base64');
  const additiveEvidenceKey = Buffer.alloc(32, 10).toString('base64');
  const run = uniqueTestId('real-data-gate');
  const evidenceDecisionIds: string[] = [];
  const provider = openai.responses.create as jest.Mock;

  async function createActiveCustomer(label: string) {
    const customer = await createTestUser(app, {
      organizationName: `${run} ${label}`,
      email: `${uniqueTestId(run)}@carbonlite-e2e.test`,
      factorProfile: 'reviewed',
    });
    await prisma.organization.update({
      where: { id: customer.user.organizationId },
      data: { customerStatus: 'ACTIVE', provisionedAt: new Date() },
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
    return customer;
  }

  async function createPlatformAdmin(label: string) {
    const platform = await createTestUser(app, {
      organizationName: `${run} ${label}`,
      email: `${uniqueTestId(run)}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: platform.user.id },
      data: { role: 'ADMIN', accountType: 'INTERNAL' },
    });
    return platform;
  }

  async function processingSideEffects(organizationId: string) {
    const [
      activityData,
      evidence,
      aiAuthorizations,
      aiJobs,
      extractionResults,
      documents,
      authorizationState,
      aiAuthorizationState,
      aiJobState,
      documentState,
      extractionState,
      extractionStarts,
      evidenceState,
    ] = await Promise.all([
      prisma.activityData.count({ where: { organizationId } }),
      prisma.realDataAuthorizationEvidence.count(),
      prisma.organizationAiAuthorization.count({ where: { organizationId } }),
      prisma.aIJob.count({ where: { organizationId } }),
      prisma.documentExtraction.count({ where: { organizationId } }),
      prisma.document.count({ where: { organizationId } }),
      prisma.organizationRealDataAuthorization.findUnique({ where: { organizationId } }),
      prisma.organizationAiAuthorization.findUnique({ where: { organizationId } }),
      // AIJob also holds extraction lease state (leaseExpiresAt).
      prisma.aIJob.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
      prisma.document.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
      prisma.documentExtraction.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
      prisma.auditLog.count({ where: { organizationId, action: 'DOCUMENT_EXTRACT_STARTED' } }),
      prisma.realDataAuthorizationEvidence.findMany({ orderBy: { id: 'asc' } }),
    ]);
    return {
      activityData,
      evidence,
      aiAuthorizations,
      aiJobs,
      extractionResults,
      documents,
      authorizationState,
      aiAuthorizationState,
      aiJobState,
      documentState,
      extractionState,
      extractionStarts,
      evidenceState,
    };
  }

  beforeAll(async () => {
    assertSafeTestDatabaseTarget();
    previousEvidenceVersion = process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION;
    previousEvidenceKeyring = process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING;
    previousAdditionalEvidenceKeys =
      process.env.REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS;
    process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION = 'e2e-v1';
    process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING = JSON.stringify([
      { version: 'e2e-v1', key: `base64:${evidenceKey}` },
    ]);
    delete process.env.REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS;
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
    if (previousAdditionalEvidenceKeys === undefined) {
      delete process.env.REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS;
    } else {
      process.env.REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS =
        previousAdditionalEvidenceKeys;
    }
  });

  async function retainedSource(label: string, format: 'json' | 'xlsx' = 'json', approved = true) {
    const customer = await createActiveCustomer(label);
    const platform = await createPlatformAdmin(`${label} admin`);
    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: customer.user.organizationId } });
    const endpoint = `/api/admin/organizations/${organization.id}/real-data-authorization`;
    const confirmation = { organizationId: organization.id, confirmationOrganizationId: organization.id, confirmationOrganizationSlug: organization.slug };
    if (approved) {
      const approval = await request(app.getHttpServer()).put(endpoint).set(authHeader(platform.accessToken)).send({
        ...confirmation, confirmRealDataApproval: true, policyVersion: 'CARBONLITE_ALLOWED_DATA_POLICY_V0_2',
        agreementEvidenceReference: 'agreement://synthetic-security-test', allowedDataScopeReference: 'scope://synthetic-security-test',
        privacySecurityReadinessReference: 'readiness://synthetic-security-test', effectiveAt: new Date(Date.now() - 60000).toISOString(),
      }).expect(200);
      evidenceDecisionIds.push(approval.body.authorization.decisionId);
    }
    const rows = [{ activityType: 'DIESEL', quantity: 1, unit: 'L', recordDate: '2026-03-07', jurisdictionCountry: 'Canada', sourceRow: 2 }];
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Main');
    const bytes = format === 'json' ? Buffer.from(JSON.stringify(rows)) : XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    const upload = await request(app.getHttpServer()).post('/api/documents/upload').set(authHeader(customer.accessToken))
      .set('X-CarbonLite-Data-Mode', approved ? 'REAL_CUSTOMER_DATA' : 'SYNTHETIC_TEST')
      .field('type', 'SPREADSHEET').attach('file', bytes, { filename: `${uniqueTestId(run)}.${format}`,
        contentType: format === 'json' ? 'application/json' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }).expect(201);
    const documentId = upload.body.id;
    // Model a retained historical real-data document with no current approval.
    if (!approved) await prisma.document.update({ where: { id: documentId }, data: { ingestionDataMode: 'REAL_CUSTOMER_DATA' } });
    const extract = () => request(app.getHttpServer()).post('/api/document-extraction/extract').set(authHeader(customer.accessToken))
      .set('X-CarbonLite-Data-Mode', 'SYNTHETIC_TEST').send({ documentId }).then(r => r);
    const confirm = () => request(app.getHttpServer()).post('/api/document-extraction/confirm').set(authHeader(customer.accessToken))
      .set('X-CarbonLite-Data-Mode', 'SYNTHETIC_TEST').send({ documentId, activities: rows }).then(r => r);
    const withdraw = () => request(app.getHttpServer()).post(`${endpoint}/withdraw`).set(authHeader(platform.accessToken))
      .send({ ...confirmation, confirmWithdrawal: true, withdrawalReason: 'SYNTHETIC_SECURITY_TEST' }).then(r => r);
    const state = async () => ({
      processing: await processingSideEffects(organization.id),
      canonical: await prisma.activityData.findMany({ where: { organizationId: organization.id }, orderBy: { id: 'asc' } }),
      audit: await prisma.auditLog.findMany({ where: { organizationId: organization.id }, orderBy: { id: 'asc' } }),
      events: await prisma.userActivityEvent.findMany({ where: { organizationId: organization.id }, orderBy: { id: 'asc' } }),
    });
    return { organization, documentId, extract, confirm, withdraw, state };
  }

  it.each(['json', 'xlsx'] as const)('denies retained real-data %s extraction after withdrawal without any processing side effect', async format => {
    const ctx = await retainedSource(`withdrawn ${format}`, format);
    expect((await ctx.withdraw()).status).toBe(201);
    const before = await ctx.state(); provider.mockClear();
    const denied = await ctx.extract(); expect(denied.status).toBe(403); expect(denied.body.code).toBe('REAL_DATA_NOT_AUTHORIZED');
    expect(await ctx.state()).toEqual(before); expect(provider).not.toHaveBeenCalled();
  });

  it('denies confirmation of retained extraction after withdrawal without mutations', async () => {
    const ctx = await retainedSource('confirmation withdrawal');
    expect((await ctx.extract()).status).toBe(201);
    expect((await ctx.withdraw()).status).toBe(201);
    const before = await ctx.state(); provider.mockClear();
    const denied = await ctx.confirm(); expect(denied.status).toBe(403); expect(denied.body.code).toBe('REAL_DATA_NOT_AUTHORIZED');
    expect(await ctx.state()).toEqual(before); expect(provider).not.toHaveBeenCalled();
  });

  it.each(['missing', 'expired'] as const)('denies %s approval for both retained-document operations', async mode => {
    const ctx = await retainedSource(mode, 'json', mode !== 'missing');
    if (mode === 'expired') await prisma.organizationRealDataAuthorization.update({ where: { organizationId: ctx.organization.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const before = await ctx.state(); provider.mockClear();
    for (const operation of [ctx.extract, ctx.confirm]) {
      const denied = await operation(); expect(denied.status).toBe(403); expect(denied.body.code).toBe('REAL_DATA_NOT_AUTHORIZED');
      expect(await ctx.state()).toEqual(before);
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it.each(['json', 'xlsx'] as const)('processes authorized real-data local %s without AI authorization', async format => {
    const ctx = await retainedSource(`allowed ${format}`, format); provider.mockClear();
    expect((await ctx.extract()).status).toBe(201);
    expect((await ctx.confirm()).body.count).toBe(1);
    expect(await prisma.organizationAiAuthorization.count({ where: { organizationId: ctx.organization.id } })).toBe(0);
    expect(provider).not.toHaveBeenCalled();
  });

  it('keeps synthetic local processing available without real-data or AI approval', async () => {
    const ctx = await retainedSource('synthetic', 'json', false);
    await prisma.document.update({ where: { id: ctx.documentId }, data: { ingestionDataMode: 'SYNTHETIC_TEST' } });
    provider.mockClear(); expect((await ctx.extract()).status).toBe(201); expect((await ctx.confirm()).body.count).toBe(1);
    expect(await prisma.organizationRealDataAuthorization.count({ where: { organizationId: ctx.organization.id } })).toBe(0);
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    ['processing-first', 'extract'], ['withdrawal-first', 'extract'],
    ['processing-first', 'confirm'], ['withdrawal-first', 'confirm'],
  ] as const)('serializes real processing against withdrawal: %s %s', async (ordering, operation) => {
    const ctx = await retainedSource(`${ordering} ${operation}`);
    if (operation === 'confirm') expect((await ctx.extract()).status).toBe(201);
    const processDocument = operation === 'confirm' ? ctx.confirm : ctx.extract;
    const deadline = async <T>(promise: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Authorization race barrier timed out')), 10000);
      })]); } finally { clearTimeout(timer); }
    };
    let release!: () => void, entered!: () => void, waiting!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const held = new Promise<void>(done => { entered = done; });
    const second = new Promise<void>(done => { waiting = done; });
    const service = app.get(RealDataAuthorizationService);
    const original = service.lockProcessingApproval.bind(service);
    let holderPid = 0, waiterPid = 0;
    const spy = jest.spyOn(service, 'lockProcessingApproval').mockImplementation(async (tx, org, shared) => {
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      const isFirst = shared === (ordering === 'processing-first');
      if (isFirst) {
        await original(tx, org, shared); holderPid = backend.pid; entered(); await gate;
      } else {
        waiterPid = backend.pid; waiting(); await original(tx, org, shared);
      }
    });
    const pending: Promise<any>[] = [];
    try {
      pending.push(ordering === 'processing-first' ? processDocument() : ctx.withdraw());
      await deadline(Promise.race([held, pending[0].then(r => { throw new Error('First request ended before lock barrier: ' + r.status); })]));
      pending.push(ordering === 'processing-first' ? ctx.withdraw() : processDocument());
      await deadline(second);
      const expires = Date.now() + 4000; let blocked = false;
      while (Date.now() < expires) {
        const [state] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT ${holderPid}::int = ANY(pg_blocking_pids(${waiterPid}::int)) AS blocked`;
        if (state.blocked) { blocked = true; break; }
        await new Promise<void>(done => setImmediate(done));
      }
      expect(blocked).toBe(true); release();
      const responses = await Promise.all(pending);
      expect(responses.map(r => r.status)).toEqual(ordering === 'processing-first' ? [201, 201] : [201, 403]);
      if (ordering === 'withdrawal-first') {
        expect(responses[1].body.code).toBe('REAL_DATA_NOT_AUTHORIZED');
        expect(await prisma.aIJob.count({ where: { organizationId: ctx.organization.id } })).toBe(operation === 'extract' ? 0 : 1);
        expect(await prisma.documentExtraction.count({ where: { documentId: ctx.documentId } })).toBe(operation === 'extract' ? 0 : 1);
        expect(await prisma.activityData.count({ where: { organizationId: ctx.organization.id } })).toBe(0);
      }
      expect((await ctx.extract()).status).toBe(403);
    } finally { release(); await Promise.allSettled(pending); spy.mockRestore(); }
  });

  it('preapproval REAL_CUSTOMER_DATA denial has zero processing side effects', async () => {
    const customer = await createActiveCustomer('preapproval denial');
    const organizationId = customer.user.organizationId;
    provider.mockClear();
    const before = await processingSideEffects(organizationId);

    await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(customer.accessToken))
      .set('X-CarbonLite-Data-Mode', 'REAL_CUSTOMER_DATA')
      .send({
        activityType: 'DIESEL',
        quantity: 1,
        unit: 'L',
        recordDate: '2026-11-13',
        sourceType: 'MANUAL',
      })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('REAL_DATA_NOT_AUTHORIZED'));

    expect(await processingSideEffects(organizationId)).toEqual(before);
    expect(provider).not.toHaveBeenCalled();
  });

  it('post-withdraw REAL_CUSTOMER_DATA denial has zero processing side effects', async () => {
    const customer = await createActiveCustomer('post-withdraw denial customer');
    const platform = await createPlatformAdmin('post-withdraw denial platform');
    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: customer.user.organizationId },
    });
    const endpoint = `/api/admin/organizations/${organization.id}/real-data-authorization`;
    const approved = await request(app.getHttpServer())
      .put(endpoint)
      .set(authHeader(platform.accessToken))
      .send({
        organizationId: organization.id,
        confirmationOrganizationId: organization.id,
        confirmationOrganizationSlug: organization.slug,
        confirmRealDataApproval: true,
        policyVersion: 'CARBONLITE_ALLOWED_DATA_POLICY_V0_2',
        agreementEvidenceReference: 'agreement://post-withdraw-denial-e2e',
        allowedDataScopeReference: 'allowed-data://post-withdraw-denial-e2e',
        privacySecurityReadinessReference: 'readiness://post-withdraw-denial-e2e',
        effectiveAt: '2026-11-13T00:00:00.000Z',
        reviewDueAt: '2027-01-01T00:00:00.000Z',
      })
      .expect(200);
    evidenceDecisionIds.push(approved.body.authorization.decisionId);
    expect(approved.body.authorization).toMatchObject({
      status: 'REAL_DATA_APPROVED',
      approvalRevision: 1,
    });

    await request(app.getHttpServer())
      .get('/api/real-data-authorization/status')
      .set(authHeader(customer.accessToken))
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        effectiveMode: 'REAL_CUSTOMER_DATA',
        configuredStatus: 'REAL_DATA_APPROVED',
      }));

    await request(app.getHttpServer())
      .post(`${endpoint}/withdraw`)
      .set(authHeader(platform.accessToken))
      .send({
        organizationId: organization.id,
        confirmationOrganizationId: organization.id,
        confirmationOrganizationSlug: organization.slug,
        confirmWithdrawal: true,
        withdrawalReason: 'POST_WITHDRAW_DENIAL_E2E',
      })
      .expect(201)
      .expect(({ body }) => expect(body.authorization.status).toBe('WITHDRAWN'));

    await request(app.getHttpServer())
      .get('/api/real-data-authorization/status')
      .set(authHeader(customer.accessToken))
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        effectiveMode: 'SYNTHETIC_ONLY',
        configuredStatus: 'WITHDRAWN',
      }));

    const evidence = await prisma.realDataAuthorizationEvidence.findMany({
      where: { authorizationDecisionId: approved.body.authorization.decisionId },
      orderBy: { createdAt: 'asc' },
    });
    expect(evidence).toHaveLength(2);
    expect(evidence.map(row => row.decision)).toEqual([
      'REAL_DATA_APPROVED',
      'WITHDRAWN',
    ]);
    const keyring = new RealDataEvidenceHmacKeyring();
    expect(evidence.every(row => (
      row.hmacKeyVersion === 'e2e-v1' && keyring.verify(
        row.hmacKeyVersion,
        organization.id,
        row.organizationIdHash,
      )
    ))).toBe(true);

    provider.mockClear();
    const before = await processingSideEffects(organization.id);
    await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(customer.accessToken))
      .set('X-CarbonLite-Data-Mode', 'REAL_CUSTOMER_DATA')
      .send({
        activityType: 'DIESEL',
        quantity: 1,
        unit: 'L',
        recordDate: '2026-11-13',
        sourceType: 'MANUAL',
      })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('REAL_DATA_NOT_AUTHORIZED'));

    expect(await processingSideEffects(organization.id)).toEqual(before);
    expect(provider).not.toHaveBeenCalled();
  });

  it('is fail-closed, platform-admin controlled, revision-bound, and tenant isolated', async () => {
    const previousRuntimeFlag = process.env.REAL_DATA_AI_PROCESSING_ENABLED;
    const previousConsentVersion = process.env.CARBONLITE_AI_CONSENT_VERSION;
    try {
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
      policyVersion: 'CARBONLITE_ALLOWED_DATA_POLICY_V0_2',
      agreementEvidenceReference: 'agreement://opaque-e2e-reference',
      allowedDataScopeReference: 'allowed-data://policy-v0.2',
      privacySecurityReadinessReference: 'readiness://opaque-e2e-reference',
      effectiveAt: '2026-11-13T00:00:00.000Z',
      reviewDueAt: '2027-01-01T00:00:00.000Z',
    };
    await request(app.getHttpServer()).put(endpoint).set(authHeader(customer.accessToken)).send(approval).expect(403);
    await request(app.getHttpServer()).put(endpoint).set(authHeader(other.accessToken)).send(approval).expect(403);
    for (const policyVersion of ['0.2', 'latest', 'customer-policy-v2']) {
      await request(app.getHttpServer())
        .put(endpoint)
        .set(authHeader(platform.accessToken))
        .send({ ...approval, policyVersion })
        .expect(400)
        .expect(({ body }) => expect(body.code).toBe('UNSUPPORTED_REAL_DATA_POLICY_VERSION'));
    }
    const approved = await request(app.getHttpServer())
      .put(endpoint)
      .set(authHeader(platform.accessToken))
      .send(approval)
      .expect(200);
    expect(approved.body).toMatchObject({
      result: 'APPROVED',
      authorization: {
        status: 'REAL_DATA_APPROVED',
        approvalRevision: 1,
        policyVersion: 'CARBONLITE_ALLOWED_DATA_POLICY_V0_2',
      },
    });
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
    delete process.env.REAL_DATA_AI_PROCESSING_ENABLED;
    await expect(app.get(AiAuthorizationService).assertProviderRequestAllowed(
      organization.id, 'OPENAI', 'DOCUMENT_EXTRACTION', 'REAL_CUSTOMER_DATA',
    )).rejects.toMatchObject({ response: expect.objectContaining({ code: 'AI_REAL_DATA_PROCESSING_DISABLED' }) });
    process.env.REAL_DATA_AI_PROCESSING_ENABLED = 'true';
    delete process.env.CARBONLITE_AI_CONSENT_VERSION;
    await expect(app.get(AiAuthorizationService).assertProviderRequestAllowed(
      organization.id, 'OPENAI', 'DOCUMENT_EXTRACTION', 'REAL_CUSTOMER_DATA',
    )).rejects.toMatchObject({ response: expect.objectContaining({ code: 'AI_RUNTIME_CONSENT_VERSION_REQUIRED' }) });
    process.env.CARBONLITE_AI_CONSENT_VERSION = 'real-data-ai-v1';
    await expect(app.get(AiAuthorizationService).assertProviderRequestAllowed(
      organization.id, 'OPENAI', 'DOCUMENT_EXTRACTION', 'REAL_CUSTOMER_DATA',
    )).rejects.toMatchObject({ status: 403 });
    await request(app.getHttpServer())
      .put(aiEndpoint)
      .set(authHeader(platform.accessToken))
      .send({ ...aiBase, authorizedDataMode: 'REAL_CUSTOMER_DATA', realDataApprovalRevision: 1 })
      .expect(200);
    process.env.CARBONLITE_AI_CONSENT_VERSION = 'mismatched-e2e-consent';
    await expect(app.get(AiAuthorizationService).assertProviderRequestAllowed(
      organization.id, 'OPENAI', 'DOCUMENT_EXTRACTION', 'REAL_CUSTOMER_DATA',
    )).rejects.toMatchObject({ response: expect.objectContaining({ code: 'AI_RUNTIME_CONSENT_VERSION_MISMATCH' }) });
    process.env.CARBONLITE_AI_CONSENT_VERSION = 'real-data-ai-v1';
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

    const immutableV1Evidence = evidence.map(row => ({
      id: row.id,
      hmacKeyVersion: row.hmacKeyVersion,
      organizationIdHash: row.organizationIdHash,
      decision: row.decision,
    }));
    process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION = 'e2e-v2';
    process.env.REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS = JSON.stringify({
      'e2e-v2': `base64:${additiveEvidenceKey}`,
    });

    const revisionTwo = await request(app.getHttpServer())
      .put(endpoint)
      .set(authHeader(platform.accessToken))
      .send({
        ...approval,
        agreementEvidenceReference: 'agreement://opaque-e2e-reference-r2',
        allowedDataScopeReference: 'allowed-data://policy-v0.2-r2',
        privacySecurityReadinessReference: 'readiness://opaque-e2e-reference-r2',
      })
      .expect(200);
    evidenceDecisionIds.push(revisionTwo.body.authorization.decisionId);
    expect(revisionTwo.body.authorization.approvalRevision).toBe(2);

    const [unchangedV1Evidence, revisionTwoEvidence] = await Promise.all([
      prisma.realDataAuthorizationEvidence.findMany({
        where: { authorizationDecisionId: approved.body.authorization.decisionId },
      }),
      prisma.realDataAuthorizationEvidence.findMany({
        where: { authorizationDecisionId: revisionTwo.body.authorization.decisionId },
      }),
    ]);
    expect(unchangedV1Evidence.map(row => ({
      id: row.id,
      hmacKeyVersion: row.hmacKeyVersion,
      organizationIdHash: row.organizationIdHash,
      decision: row.decision,
    }))).toEqual(immutableV1Evidence);
    expect(revisionTwoEvidence).toHaveLength(1);
    expect(revisionTwoEvidence[0].hmacKeyVersion).toBe('e2e-v2');

    const mergedKeyring = new RealDataEvidenceHmacKeyring();
    expect(mergedKeyring.activeSigner().hmacKeyVersion).toBe('e2e-v2');
    expect(evidence.every(row => mergedKeyring.verify(
      row.hmacKeyVersion,
      organization.id,
      row.organizationIdHash,
    ))).toBe(true);
    expect(mergedKeyring.verify(
      revisionTwoEvidence[0].hmacKeyVersion,
      organization.id,
      revisionTwoEvidence[0].organizationIdHash,
    )).toBe(true);
    expect(JSON.stringify(revisionTwoEvidence)).not.toContain(additiveEvidenceKey);
    } finally {
      if (previousRuntimeFlag === undefined) delete process.env.REAL_DATA_AI_PROCESSING_ENABLED;
      else process.env.REAL_DATA_AI_PROCESSING_ENABLED = previousRuntimeFlag;
      if (previousConsentVersion === undefined) delete process.env.CARBONLITE_AI_CONSENT_VERSION;
      else process.env.CARBONLITE_AI_CONSENT_VERSION = previousConsentVersion;
    }
  });
});

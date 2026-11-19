import { authorizeSyntheticDocumentExtraction } from './helpers/synthetic-ai-authorization';
import { ActivityTrackingService } from '../src/activity-tracking/activity-tracking.service';
import { ExtractionOperationsService } from '../src/document-extraction/extraction-operations.service';
import { Prisma } from '@prisma/client';
import { AuditLogService } from '../src/audit-log/audit-log.service';
import { DOCUMENT_STORAGE, DocumentStorage, documentStorageKey } from '../src/documents/document-storage';
import * as XLSX from 'xlsx';
import { RealDataAuthorizationService } from '../src/real-data-authorization/real-data-authorization.service';
import { INestApplication } from '@nestjs/common';
import { AiAuthorizedDataMode } from '@prisma/client';
import request from 'supertest';
import { AiAuthorizationService } from '../src/ai-authorization/ai-authorization.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaModule } from '../src/prisma/prisma.module';
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
      prisma.auditLog.count({ where: { organizationId, action: 'EXTRACT_DOCUMENT_STARTED' } }),
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
    prisma = app.select(PrismaModule).get(PrismaService, { strict: true });
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
    return { organization, documentId, extract, confirm, withdraw, state, customer };
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
    let holderPid = 0, waiterPid = 0, sharedCalls = 0;
    const spy = jest.spyOn(service, 'lockProcessingApproval').mockImplementation(async (tx, org, shared) => {
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      if (shared && operation === 'extract') {
        sharedCalls++;
        if (ordering === 'processing-first' && sharedCalls === 1) { await original(tx, org, shared); return; }
      }
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

  function failAtomicExtraction(documentId: string, point: 'after-upsert' | 'before-audit', times = 1) {
    let reached = 0;
    const audit = app.get(AuditLogService);
    const log = audit.log.bind(audit);
    const transaction = prisma.$transaction.bind(prisma);
    const spy = point === 'before-audit'
      ? jest.spyOn(audit, 'log').mockImplementation(async (input, tx) => {
        if (input.action === 'EXTRACT_DOCUMENT' && input.entityId === documentId && reached < times) {
          reached++; throw new Error('Synthetic application audit failure before SQL');
        }
        return log(input, tx);
      })
      : jest.spyOn(prisma, '$transaction').mockImplementation(((work: any, options: any) => {
        if (typeof work !== 'function') return transaction(work, options);
        return transaction(tx => work(new Proxy(tx, { get(target, key) {
          if (key !== 'documentExtraction') return Reflect.get(target, key);
          return new Proxy(target.documentExtraction, { get(delegate, operation) {
            if (operation !== 'upsert') return Reflect.get(delegate, operation);
            return async (args: any) => {
              const result = await delegate.upsert(args);
              if (args.where.documentId === documentId && reached < times) {
                reached++; throw new Error('Synthetic application failure after extraction upsert');
              }
              return result;
            };
          } });
        } })), options);
      }) as any);
    return { restore: () => spy.mockRestore(), reached: () => reached };
  }

  async function extractionEvidence(documentId: string) {
    return {
      results: await prisma.documentExtraction.findMany({ where: { documentId }, orderBy: { id: 'asc' } }),
      successAudits: await prisma.auditLog.findMany({ where: { entityId: documentId, action: 'EXTRACT_DOCUMENT' }, orderBy: { id: 'asc' } }),
    };
  }
  async function sourceBytes(documentId: string) {
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    return app.get<DocumentStorage>(DOCUMENT_STORAGE).read(documentStorageKey(doc.fileUrl));
  }
  const atomicCases = (['json', 'xlsx'] as const).flatMap(format =>
    (['after-upsert', 'before-audit'] as const).flatMap(point =>
      [false, true].map(previous => ({ format, point, previous }))));
  it.each(atomicCases)('atomic extraction rollback $format $point previous=$previous', async ({ format, point, previous }) => {
    const ctx = await retainedSource(`atomic ${format} ${point} ${previous}`, format);
    if (previous) expect((await ctx.extract()).status).toBe(201);
    const before = await extractionEvidence(ctx.documentId), bytes = await sourceBytes(ctx.documentId);
    const usage = await prisma.organizationQuotaUsage.findMany({ where: { organizationId: ctx.organization.id }, orderBy: { id: 'asc' } });
    provider.mockClear();
    const injected = failAtomicExtraction(ctx.documentId, point);
    try {
      const failed = await ctx.extract(); expect(failed.status).toBe(500);
      expect(failed.body.message).toBe('Extraction failed. Please try again or upload the file again.');
      expect(injected.reached()).toBe(1);
      expect(await extractionEvidence(ctx.documentId)).toEqual(before);
      expect(await prisma.document.findUnique({ where: { id: ctx.documentId } })).toMatchObject({ status: 'EXTRACTION_FAILED' });
      const failures = await prisma.auditLog.findMany({ where: { entityId: ctx.documentId, action: 'EXTRACT_DOCUMENT_FAILED' } });
      expect(failures).toHaveLength(1);
      expect(failures[0].newValue).toMatchObject({ status: 'EXTRACTION_FAILED' });
      expect(await prisma.aIJob.findMany({ where: { documentId: ctx.documentId, status: 'RUNNING' } })).toHaveLength(0);
      const failedLeases = await prisma.aIJob.findMany({ where: { documentId: ctx.documentId, status: 'FAILED' } });
      expect(failedLeases).toHaveLength(1); expect(failedLeases[0].leaseExpiresAt).toBeNull();
      expect(await prisma.organizationQuotaUsage.findMany({ where: { organizationId: ctx.organization.id }, orderBy: { id: 'asc' } })).toEqual(usage);
      expect(provider).not.toHaveBeenCalled();
      expect(await sourceBytes(ctx.documentId)).toEqual(bytes);
    } finally { injected.restore(); }
    expect((await ctx.extract()).status).toBe(201);
    const after = await extractionEvidence(ctx.documentId);
    expect(after.results).toHaveLength(1); expect(after.successAudits).toHaveLength(before.successAudits.length + 1);
  });

  it.each((['json', 'xlsx'] as const).flatMap(format =>
    (['after-status', 'before-failure-audit'] as const).map(point => ({ format, point }))))
  ('atomic extraction failure-state rollback $format $point', async ({ format, point }) => {
    const ctx = await retainedSource(`failure cleanup ${format} ${point}`, format);
    const originalDocument = await prisma.document.findUniqueOrThrow({ where: { id: ctx.documentId } });
    const bytes = await sourceBytes(ctx.documentId), before = await extractionEvidence(ctx.documentId);
    const injected = failAtomicExtraction(ctx.documentId, 'after-upsert');
    const audit = app.get(AuditLogService), log = audit.log.bind(audit);
    let reached = 0;
    const failure = jest.spyOn(audit, 'log').mockImplementation(async (input, tx) => {
      if (input.entityId === ctx.documentId && input.action === 'EXTRACT_DOCUMENT_FAILED') {
        reached++;
        // The update is already executed in the owning transaction; fail before audit SQL.
        if (point === 'after-status') {
          const row = await (tx as PrismaService).document.findUnique({ where: { id: ctx.documentId } });
          expect(row?.status).toBe('EXTRACTION_FAILED');
        }
        throw new Error('Synthetic failure-state persistence exception');
      }
      return log(input, tx);
    });
    try {
      expect((await ctx.extract()).status).toBe(500);
      expect(reached).toBe(1); expect(injected.reached()).toBe(1);
      expect(await extractionEvidence(ctx.documentId)).toEqual(before);
      const after = await prisma.document.findUniqueOrThrow({ where: { id: ctx.documentId } });
      expect(after).toEqual({ ...originalDocument, status: 'PROCESSING', updatedAt: after.updatedAt });
      expect(await prisma.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_DOCUMENT_STARTED' } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_DOCUMENT_FAILED' } })).toBe(0);
      expect(await sourceBytes(ctx.documentId)).toEqual(bytes);
    } finally { failure.mockRestore(); injected.restore(); }
    // Required failure evidence also owns lease retirement. When that write
    // fails, the lease remains active; explicit retry waits for normal expiry.
    const lease = await prisma.aIJob.findFirstOrThrow({ where: { documentId: ctx.documentId } });
    expect(lease.status).toBe('RUNNING'); expect(lease.leaseExpiresAt).not.toBeNull();
    expect((await ctx.extract()).status).toBe(409);
    await prisma.aIJob.update({ where: { id: lease.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    expect((await ctx.extract()).status).toBe(201);
  });

  it.each(['json', 'xlsx'] as const)('atomic extraction retry rollback remains recoverable: %s', async format => {
    const ctx = await retainedSource(`double retry ${format}`, format);
    const bytes = await sourceBytes(ctx.documentId);
    const injected = failAtomicExtraction(ctx.documentId, 'before-audit', 2);
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        expect((await ctx.extract()).status).toBe(500);
        expect(await prisma.documentExtraction.count({ where: { documentId: ctx.documentId } })).toBe(0);
        expect(await prisma.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_DOCUMENT' } })).toBe(0);
        expect(await prisma.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_DOCUMENT_FAILED' } })).toBe(attempt);
        expect(await sourceBytes(ctx.documentId)).toEqual(bytes);
      }
      expect(injected.reached()).toBe(2);
    } finally { injected.restore(); }
    expect((await ctx.extract()).status).toBe(201);
    expect(await prisma.documentExtraction.count({ where: { documentId: ctx.documentId } })).toBe(1);
  });

  const admissions = () => app.get(ExtractionOperationsService);
  // These cases inspect durable DB admissions without executing work. Release
  // the process reservation explicitly; the durable lease stays active for validation.
  const admitForInspection = async (organizationId: string, documentId: string) => {
    const admission = await admissions().admit(organizationId, documentId);
    admission.release();
    return admission;
  };
  const validateOperation = (ctx: Awaited<ReturnType<typeof retainedSource>>, operationId: string) =>
    prisma.$transaction(tx => admissions().lockAndValidate(tx, ctx.organization.id, ctx.documentId, operationId));

  it.each([true, false])('durable admission stores a server-owned decision/revision with quota enabled=%s', async enabled => {
    const ctx = await retainedSource(`durable quota ${enabled}`);
    await prisma.organizationQuota.update({ where: { organizationId: ctx.organization.id }, data: { enabled } });
    const usage = await prisma.organizationQuotaUsage.findMany({ where: { organizationId: ctx.organization.id }, orderBy: { id: 'asc' } });
    const approval = await prisma.organizationRealDataAuthorization.findUniqueOrThrow({ where: { organizationId: ctx.organization.id } });
    const admitted = await admitForInspection(ctx.organization.id, ctx.documentId);
    expect(admitted.quotaEnforced).toBe(enabled);
    const job = await prisma.aIJob.findUniqueOrThrow({ where: { id: admitted.operation.id } });
    expect(job).toMatchObject({ organizationId: ctx.organization.id, documentId: ctx.documentId, status: 'RUNNING',
      inputJson: { version: 2, phase: 'ADMITTED', operationId: job.id, organizationId: ctx.organization.id,
        documentId: ctx.documentId, ingestionDataMode: 'REAL_CUSTOMER_DATA', realDataDecisionId: approval.decisionId,
        approvalRevision: approval.approvalRevision, provider: null, processingScope: null, consentVersion: null, aiGrantGeneration: null } });
    expect(job.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await prisma.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_DOCUMENT_STARTED' } })).toBe(1);
    expect(await prisma.userActivityEvent.count({ where: { entityId: ctx.documentId, eventName: 'DOCUMENT_EXTRACT_STARTED' } })).toBe(1);
    expect(await prisma.organizationQuotaUsage.findMany({ where: { organizationId: ctx.organization.id }, orderBy: { id: 'asc' } })).toEqual(usage);
    expect((await validateOperation(ctx, job.id)).metadata.realDataDecisionId).toBe(approval.decisionId);
  });

  it('durable admission commits operation and required start evidence before storage reads', async () => {
    const ctx = await retainedSource('committed admission before bytes');
    const storage = app.get<DocumentStorage>(DOCUMENT_STORAGE), read = storage.read.bind(storage);
    let observed = false;
    const spy = jest.spyOn(storage, 'read').mockImplementation(async key => {
      const jobs = await prisma.aIJob.findMany({ where: { documentId: ctx.documentId, status: 'RUNNING' } });
      expect(jobs).toHaveLength(1);
      expect(await prisma.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_DOCUMENT_STARTED' } })).toBe(1);
      expect(await prisma.userActivityEvent.count({ where: { entityId: ctx.documentId, eventName: 'DOCUMENT_EXTRACT_STARTED' } })).toBe(1);
      observed = true; return read(key);
    });
    try { expect((await ctx.extract()).status).toBe(201); expect(observed).toBe(true); }
    finally { spy.mockRestore(); }
  });

  it('durable admission denies withdrawal-first without jobs or start evidence', async () => {
    const ctx = await retainedSource('admission withdrawal first');
    expect((await ctx.withdraw()).status).toBe(201);
    const before = await ctx.state();
    await expect(admitForInspection(ctx.organization.id, ctx.documentId)).rejects.toMatchObject({ status: 403, response: expect.objectContaining({ code: 'REAL_DATA_NOT_AUTHORIZED' }) });
    expect(await ctx.state()).toEqual(before);
  });

  it.each(['approvalRevision', 'realDataDecisionId'] as const)('durable operation rejects stale %s', async field => {
    const ctx = await retainedSource(`stale ${field}`);
    const admission = await admitForInspection(ctx.organization.id, ctx.documentId);
    const job = await prisma.aIJob.findUniqueOrThrow({ where: { id: admission.operation.id } });
    await prisma.aIJob.update({ where: { id: job.id }, data: { inputJson: { ...(job.inputJson as Prisma.JsonObject), [field]: field === 'approvalRevision' ? 999 : 'wrong-decision' } } });
    const before = await ctx.state();
    await expect(validateOperation(ctx, job.id)).rejects.toMatchObject({ status: 403, response: expect.objectContaining({ code: field === 'approvalRevision' ? 'REAL_DATA_APPROVAL_REVISION_MISMATCH' : 'REAL_DATA_APPROVAL_DECISION_MISMATCH' }) });
    expect(await ctx.state()).toEqual(before);
  });

  it('durable operation cannot cross organization or source boundaries', async () => {
    const a = await retainedSource('operation tenant A'), b = await retainedSource('operation tenant B');
    const admission = await admitForInspection(a.organization.id, a.documentId);
    const before = await b.state();
    await expect(validateOperation(b, admission.operation.id)).rejects.toMatchObject({ status: 403, response: expect.objectContaining({ code: 'EXTRACTION_OPERATION_INVALID' }) });
    await expect(admitForInspection(b.organization.id, a.documentId)).rejects.toMatchObject({ status: 404 });
    expect(await b.state()).toEqual(before);
  });

  it('durable operation rejects replacement approval even after reapproval', async () => {
    const ctx = await retainedSource('replacement approval');
    const old = await admitForInspection(ctx.organization.id, ctx.documentId);
    const previous = await prisma.organizationRealDataAuthorization.findUniqueOrThrow({ where: { organizationId: ctx.organization.id } });
    expect((await ctx.withdraw()).status).toBe(201);
    // Normal supported approval service, with a synthetic platform-admin fixture.
    const admin = await createPlatformAdmin('replacement approval admin');
    const reapproved = await request(app.getHttpServer()).put(`/api/admin/organizations/${ctx.organization.id}/real-data-authorization`).set(authHeader(admin.accessToken)).send({
      organizationId: ctx.organization.id, confirmationOrganizationId: ctx.organization.id, confirmationOrganizationSlug: ctx.organization.slug,
      confirmRealDataApproval: true, policyVersion: 'CARBONLITE_ALLOWED_DATA_POLICY_V0_2', agreementEvidenceReference: 'agreement://replacement',
      allowedDataScopeReference: 'scope://replacement', privacySecurityReadinessReference: 'readiness://replacement', effectiveAt: new Date(Date.now() - 1000).toISOString(),
    }).expect(200);
    evidenceDecisionIds.push(reapproved.body.authorization.decisionId);
    expect(reapproved.body.authorization.approvalRevision).toBe(previous.approvalRevision + 1);
    expect(reapproved.body.authorization.decisionId).not.toBe(previous.decisionId);
    await expect(validateOperation(ctx, old.operation.id)).rejects.toMatchObject({ status: 403, response: expect.objectContaining({ code: 'REAL_DATA_APPROVAL_REVISION_MISMATCH' }) });
  });

  it.each([
    ['null', null], ['empty', {}], ['primitive', 'not-metadata'],
    ['version', { version: 3 }], ['phase', { phase: 'PROVIDER_ADMITTED' }],
    ['identity', { operationId: 'copied-operation' }], ['tenant', { organizationId: 'other-tenant' }],
    ['source', { documentId: 'other-source' }], ['mode', { ingestionDataMode: 'SYNTHETIC_TEST', realDataDecisionId: null, approvalRevision: null }],
    ['revision', { approvalRevision: null }], ['provider', { provider: 'OPENAI' }],
  ])('durable operation fails closed for malformed metadata: %s', async (label, change) => {
    const ctx = await retainedSource(`malformed ${label}`);
    const admission = await admitForInspection(ctx.organization.id, ctx.documentId);
    const job = await prisma.aIJob.findUniqueOrThrow({ where: { id: admission.operation.id } });
    const metadata = change === null || typeof change === 'string' || label === 'empty' ? change : { ...(job.inputJson as Prisma.JsonObject), ...(change as object) };
    await prisma.aIJob.update({ where: { id: job.id }, data: { inputJson: metadata === null ? Prisma.DbNull : metadata as Prisma.InputJsonValue } });
    const before = await ctx.state();
    await expect(validateOperation(ctx, job.id)).rejects.toMatchObject({ status: 403, response: expect.objectContaining({ code: 'EXTRACTION_OPERATION_INVALID' }) });
    expect(await ctx.state()).toEqual(before);
  });

  it('durable operation expires and validates with the supplied transaction only', async () => {
    const ctx = await retainedSource('transaction-only fencing');
    const admission = await admitForInspection(ctx.organization.id, ctx.documentId);
    const transaction = prisma.$transaction.bind(prisma);
    const nested = jest.spyOn(prisma, '$transaction');
    const rootRead = jest.spyOn(prisma.organizationRealDataAuthorization, 'findUnique');
    try {
      await transaction(tx => admissions().lockAndValidate(tx, ctx.organization.id, ctx.documentId, admission.operation.id));
      expect(nested).not.toHaveBeenCalled(); expect(rootRead).not.toHaveBeenCalled();
    } finally { nested.mockRestore(); rootRead.mockRestore(); }
    await prisma.aIJob.update({ where: { id: admission.operation.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    await expect(validateOperation(ctx, admission.operation.id)).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: 'EXTRACTION_OPERATION_NOT_ACTIVE' }) });
  });

  it.each(['audit', 'activity'] as const)('durable admission rolls back required start %s failure and permits retry', async point => {
    const ctx = await retainedSource(`start rollback ${point}`), before = await ctx.state();
    const audit = app.get(AuditLogService), log = audit.log.bind(audit);
    const tracker = app.get(ActivityTrackingService), track = tracker.track.bind(tracker);
    const spy = point === 'audit'
      ? jest.spyOn(audit, 'log').mockImplementation(async (input, tx) => { if (input.action === 'EXTRACT_DOCUMENT_STARTED') throw new Error('Synthetic admission audit failure'); return log(input, tx); })
      : jest.spyOn(tracker, 'track').mockImplementation(async (input, tx) => { if (input.eventName === 'DOCUMENT_EXTRACT_STARTED') throw new Error('Synthetic admission activity failure'); return track(input, tx); });
    try { await expect(admitForInspection(ctx.organization.id, ctx.documentId)).rejects.toThrow('Synthetic admission'); expect(await ctx.state()).toEqual(before); }
    finally { spy.mockRestore(); }
    const admitted = await admitForInspection(ctx.organization.id, ctx.documentId);
    expect((await validateOperation(ctx, admitted.operation.id)).job.status).toBe('RUNNING');
  });

  it('durable synthetic admission needs neither real-data nor AI authorization with quotas disabled', async () => {
    const ctx = await retainedSource('synthetic durable disabled', 'json', false);
    await prisma.document.update({ where: { id: ctx.documentId }, data: { ingestionDataMode: 'SYNTHETIC_TEST' } });
    await prisma.organizationQuota.update({ where: { organizationId: ctx.organization.id }, data: { enabled: false } });
    expect((await ctx.extract()).status).toBe(201);
    const jobs = await prisma.aIJob.findMany({ where: { documentId: ctx.documentId } });
    expect(jobs).toHaveLength(1); expect(jobs[0].status).toBe('COMPLETED');
    expect(jobs[0].inputJson).toMatchObject({ ingestionDataMode: 'SYNTHETIC_TEST', realDataDecisionId: null, approvalRevision: null });
    expect(await prisma.organizationRealDataAuthorization.count({ where: { organizationId: ctx.organization.id } })).toBe(0);
    expect(await prisma.organizationAiAuthorization.count({ where: { organizationId: ctx.organization.id } })).toBe(0);
  });

  it('durable provider admission binds independent AI scope and consent without calling the provider', async () => {
    const ctx = await retainedSource('provider admission', 'json', false);
    await authorizeSyntheticDocumentExtraction(app, ctx.customer);
    const uploaded = await request(app.getHttpServer()).post('/api/documents/upload').set(authHeader(ctx.customer.accessToken))
      .field('type', 'PDF').attach('file', Buffer.from('%PDF-1.4\n% Synthetic admission fixture\n%%EOF\n'), { filename: `${uniqueTestId(run)}.pdf`, contentType: 'application/pdf' }).expect(201);
    const providerContext = { ...ctx, documentId: uploaded.body.id };
    provider.mockClear();
    const admission = await admitForInspection(ctx.organization.id, providerContext.documentId);
    expect((await validateOperation(providerContext, admission.operation.id)).metadata).toMatchObject({
      provider: 'OPENAI', processingScope: 'DOCUMENT_EXTRACTION', consentVersion: 'e2e-synthetic-consent-v1',
      ingestionDataMode: 'SYNTHETIC_TEST', realDataDecisionId: null, approvalRevision: null,
    });
    await prisma.organizationAiAuthorization.update({ where: { organizationId: ctx.organization.id }, data: { consentVersion: 'changed-synthetic-consent' } });
    await expect(validateOperation(providerContext, admission.operation.id)).rejects.toMatchObject({ status: 403, response: expect.objectContaining({ code: 'EXTRACTION_OPERATION_INVALID' }) });
    const platform = await createPlatformAdmin('provider withdrawal admin');
    await app.get(AiAuthorizationService).withdraw(ctx.organization.id, platform.user.id, 'SYNTHETIC_ADMISSION_TEST');
    await expect(validateOperation(providerContext, admission.operation.id)).rejects.toMatchObject({ status: 403, response: expect.objectContaining({ code: 'AI_AUTHORIZATION_REQUIRED' }) });
    expect(provider).not.toHaveBeenCalled();
  });

  it('durable operation validation rejects approval expiry', async () => {
    const ctx = await retainedSource('admission expiry');
    const admitted = await admitForInspection(ctx.organization.id, ctx.documentId);
    await prisma.organizationRealDataAuthorization.update({ where: { organizationId: ctx.organization.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const before = await ctx.state();
    await expect(validateOperation(ctx, admitted.operation.id)).rejects.toMatchObject({ status: 403, response: expect.objectContaining({ code: 'REAL_DATA_NOT_AUTHORIZED' }) });
    expect(await ctx.state()).toEqual(before);
  });

  it('durable admission committed before withdrawal cannot start stale processing afterward', async () => {
    const ctx = await retainedSource('withdrawal between admission and work');
    const service = admissions(), admit = service.admit.bind(service);
    const spy = jest.spyOn(service, 'admit').mockImplementation(async (...args) => {
      const result = await admit(...args);
      expect((await ctx.withdraw()).status).toBe(201);
      return result;
    });
    provider.mockClear();
    try {
      const response = await ctx.extract(); expect(response.status).toBe(403); expect(response.body.code).toBe('REAL_DATA_NOT_AUTHORIZED');
      const jobs = await prisma.aIJob.findMany({ where: { documentId: ctx.documentId } });
      expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ status: 'FAILED', leaseExpiresAt: null });
      expect(await prisma.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_DOCUMENT_STARTED' } })).toBe(1);
      expect(await prisma.documentExtraction.count({ where: { documentId: ctx.documentId } })).toBe(0);
      expect(await prisma.document.findUnique({ where: { id: ctx.documentId } })).toMatchObject({ status: 'EXTRACTION_FAILED' });
      expect(await prisma.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_DOCUMENT_FAILED' } })).toBe(1);
      expect(provider).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('durable operation identity cannot be supplied through the public extraction DTO', async () => {
    const ctx = await retainedSource('client identity rejected'); const before = await ctx.state();
    await request(app.getHttpServer()).post('/api/document-extraction/extract').set(authHeader(ctx.customer.accessToken))
      .send({ documentId: ctx.documentId, operationId: 'client-operation', metadata: { ingestionDataMode: 'SYNTHETIC_TEST' } }).expect(400);
    expect(await ctx.state()).toEqual(before);
  });

  it('durable admission fails boundedly on a held document lock and can retry without side effects', async () => {
    const ctx = await retainedSource('admission lock wait');
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>(done => { entered = done; });
    const gate = new Promise<void>(done => { release = done; });
    const holder = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${ctx.documentId} FOR UPDATE`;
      entered(); await gate;
    });
    try {
      await held;
      const before = await ctx.state();
      await expect(admitForInspection(ctx.organization.id, ctx.documentId)).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: 'EXTRACTION_ADMISSION_BUSY' }) });
      expect(await ctx.state()).toEqual(before);
    } finally { release(); await holder; }
    const admitted = await admitForInspection(ctx.organization.id, ctx.documentId);
    expect((await validateOperation(ctx, admitted.operation.id)).job.status).toBe('RUNNING');
  });

  it.each([undefined, null, '', ' ', 123])('durable operation rejects missing or invalid operation ID: %s', async identity => {
    const ctx = await retainedSource(`missing operation ${String(identity)}`);
    await admitForInspection(ctx.organization.id, ctx.documentId);
    const before = await ctx.state();
    await expect(validateOperation(ctx, identity as unknown as string)).rejects.toMatchObject({ status: 403, response: expect.objectContaining({ code: 'EXTRACTION_OPERATION_INVALID' }) });
    expect(await ctx.state()).toEqual(before);
  });

  it.each([Prisma.TransactionIsolationLevel.RepeatableRead, Prisma.TransactionIsolationLevel.Serializable])
  ('durable operation fencing refuses stale-snapshot transaction isolation: %s', async isolationLevel => {
    const ctx = await retainedSource(`isolation ${isolationLevel}`);
    const admission = await admitForInspection(ctx.organization.id, ctx.documentId);
    const before = await ctx.state();
    await expect(prisma.$transaction(tx => admissions().lockAndValidate(tx, ctx.organization.id, ctx.documentId, admission.operation.id), { isolationLevel }))
      .rejects.toMatchObject({ status: 503, response: expect.objectContaining({ code: 'PROCESSING_FENCE_ISOLATION_UNSUPPORTED' }) });
    expect(await ctx.state()).toEqual(before);
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
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }
  async function pausedRead(ctx: Awaited<ReturnType<typeof retainedSource>>) {
    const storage = app.get<DocumentStorage>(DOCUMENT_STORAGE), read = storage.read.bind(storage);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: ctx.documentId } });
    const entered = deferred(), release = deferred();
    const spy = jest.spyOn(storage, 'read').mockImplementation(async key => {
      const bytes = await read(key);
      if (key === documentStorageKey(doc.fileUrl)) { entered.resolve(); await release.promise; }
      return bytes;
    });
    const pending = ctx.extract();
    await entered.promise;
    return { pending, release: release.resolve, restore: () => spy.mockRestore() };
  }
  async function expectFenced(ctx: Awaited<ReturnType<typeof retainedSource>>) {
    expect(await prisma.documentExtraction.count({ where: { documentId: ctx.documentId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_DOCUMENT' } })).toBe(0);
    expect(await prisma.aIJob.count({ where: { documentId: ctx.documentId, status: 'COMPLETED' } })).toBe(0);
    expect(await prisma.aIJob.count({ where: { documentId: ctx.documentId, status: 'RUNNING' } })).toBe(0);
  }
  async function providerSource(label: string) {
    const ctx = await retainedSource(label);
    const platform = await createPlatformAdmin(label + ' AI admin');
    await app.get(AiAuthorizationService).recordDecision(ctx.organization.id, platform.user.id, {
      status: 'ENABLED', consentVersion: 'real-data-ai-v1', provider: 'OPENAI', processingScope: 'DOCUMENT_EXTRACTION',
      authorizedDataMode: 'REAL_CUSTOMER_DATA', realDataApprovalRevision: 1,
      evidenceReference: 'synthetic://phase-c', authorizedRepresentativeReference: 'synthetic-operator', effectiveAt: new Date(Date.now() - 60000).toISOString(),
    });
    const upload = await request(app.getHttpServer()).post('/api/documents/upload').set(authHeader(ctx.customer.accessToken))
      .set('X-CarbonLite-Data-Mode', 'REAL_CUSTOMER_DATA').field('type', 'PDF')
      .attach('file', Buffer.from('%PDF-1.4\n% Synthetic Phase C fixture\n%%EOF\n'), { filename: `${uniqueTestId(run)}.pdf`, contentType: 'application/pdf' }).expect(201);
    const documentId = upload.body.id;
    return { ...ctx, documentId, extract: () => request(app.getHttpServer()).post('/api/document-extraction/extract').set(authHeader(ctx.customer.accessToken)).send({ documentId }).then(r => r) };
  }
  async function withProviderConfiguration(work: () => Promise<void>) {
    const flag = process.env.REAL_DATA_AI_PROCESSING_ENABLED, consent = process.env.CARBONLITE_AI_CONSENT_VERSION;
    process.env.REAL_DATA_AI_PROCESSING_ENABLED = 'true'; process.env.CARBONLITE_AI_CONSENT_VERSION = 'real-data-ai-v1';
    provider.mockReset(); provider.mockResolvedValue({ output_text: JSON.stringify({ activities: [] }) });
    try { await work(); } finally {
      if (flag === undefined) delete process.env.REAL_DATA_AI_PROCESSING_ENABLED; else process.env.REAL_DATA_AI_PROCESSING_ENABLED = flag;
      if (consent === undefined) delete process.env.CARBONLITE_AI_CONSENT_VERSION; else process.env.CARBONLITE_AI_CONSENT_VERSION = consent;
      provider.mockReset();
    }
  }

  it.each(['json', 'xlsx'] as const)('Phase C withdrawal during %s storage completes before storage release and fences results', async format => {
    const ctx = await retainedSource('Phase C storage ' + format, format), bytes = await sourceBytes(ctx.documentId);
    const usage = await prisma.organizationQuotaUsage.findMany({ where: { organizationId: ctx.organization.id } });
    provider.mockClear(); const pause = await pausedRead(ctx);
    try {
      expect((await ctx.withdraw()).status).toBe(201); // Must complete while I/O is still paused.
      pause.release(); const response = await pause.pending;
      expect(response.status).toBe(403); expect(response.body.code).toBe('REAL_DATA_NOT_AUTHORIZED');
      await expectFenced(ctx); expect(provider).not.toHaveBeenCalled();
      expect(await prisma.organizationQuotaUsage.findMany({ where: { organizationId: ctx.organization.id } })).toEqual(usage);
    } finally { pause.release(); await pause.pending; pause.restore(); }
    expect(await sourceBytes(ctx.documentId)).toEqual(bytes);
  });

  it('Phase C withdrawal before provider dispatch makes zero provider calls', async () => withProviderConfiguration(async () => {
    const ctx = await providerSource('Phase C dispatch loses'), pause = await pausedRead(ctx);
    try {
      expect((await ctx.withdraw()).status).toBe(201); pause.release();
      expect((await pause.pending).status).toBe(403); expect(provider).not.toHaveBeenCalled(); await expectFenced(ctx);
      expect(await prisma.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_PROVIDER_DISPATCH_ADMITTED' } })).toBe(0);
    } finally { pause.release(); await pause.pending; pause.restore(); }
  }));

  it('Phase C admitted provider attempt is not replayed and withdrawn results cannot commit', async () => withProviderConfiguration(async () => {
    const ctx = await providerSource('Phase C dispatch wins'), entered = deferred(), release = deferred();
    let signal: AbortSignal | undefined;
    provider.mockImplementation(async (_input, options) => { signal = options.signal; entered.resolve(); await release.promise; return { output_text: JSON.stringify({ activities: [] }) }; });
    const pending = ctx.extract(); await entered.promise;
    try {
      const job = await prisma.aIJob.findFirstOrThrow({ where: { documentId: ctx.documentId } });
      expect(job.inputJson).toMatchObject({ phase: 'DISPATCH_ADMITTED' });
      expect(await prisma.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_PROVIDER_DISPATCH_ADMITTED' } })).toBe(1);
      await expect(prisma.$transaction(tx => admissions().dispatch(tx, ctx.organization.id, ctx.documentId, job.id))).rejects.toMatchObject({ status: 403 });
      expect((await ctx.withdraw()).status).toBe(201); expect(signal?.aborted).toBe(true);
      release.resolve(); expect((await pending).status).toBe(403); expect(provider).toHaveBeenCalledTimes(1); await expectFenced(ctx);
    } finally { release.resolve(); await pending; }
  }));

  it.each(['expiry', 'reapproval', 'lease', 'replacement'] as const)('Phase C final fence rejects %s during work', async kind => {
    const ctx = await retainedSource('Phase C stale ' + kind), pause = await pausedRead(ctx);
    try {
      if (kind === 'expiry') await prisma.organizationRealDataAuthorization.update({ where: { organizationId: ctx.organization.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      if (kind === 'lease') await prisma.aIJob.updateMany({ where: { documentId: ctx.documentId }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
      if (kind === 'replacement') await prisma.document.update({ where: { id: ctx.documentId }, data: { fileName: 'replaced-source.json' } });
      if (kind === 'reapproval') {
        expect((await ctx.withdraw()).status).toBe(201);
        const previous = await prisma.organizationRealDataAuthorization.findUniqueOrThrow({ where: { organizationId: ctx.organization.id } });
        const platform = await createPlatformAdmin('Phase C reapproval admin');
        const approval = await request(app.getHttpServer()).put(`/api/admin/organizations/${ctx.organization.id}/real-data-authorization`).set(authHeader(platform.accessToken)).send({
          organizationId: ctx.organization.id, confirmationOrganizationId: ctx.organization.id, confirmationOrganizationSlug: ctx.organization.slug, confirmRealDataApproval: true,
          policyVersion: 'CARBONLITE_ALLOWED_DATA_POLICY_V0_2', agreementEvidenceReference: 'synthetic://phase-c-r2', allowedDataScopeReference: 'synthetic://scope',
          privacySecurityReadinessReference: 'synthetic://phase-c-readiness',
          effectiveAt: new Date(Date.now() - 1000).toISOString(),
        });
        expect(approval.status).toBe(200); expect(approval.body.authorization.approvalRevision).toBe(2);
        expect(approval.body.authorization.decisionId).not.toBe(previous.decisionId); evidenceDecisionIds.push(approval.body.authorization.decisionId);
      }
      pause.release(); expect((await pause.pending).status).toBe(kind === 'lease' ? 409 : 403); await expectFenced(ctx);
      if (kind === 'lease') {
        expect((await ctx.extract()).status).toBe(201); // Explicit new attempt, no automatic replay.
        expect(await prisma.aIJob.count({ where: { documentId: ctx.documentId, status: 'COMPLETED' } })).toBe(1);
      }
    } finally { pause.release(); await pause.pending; pause.restore(); }
  });

  it('Phase C withdrawal after result upsert rolls back result, success evidence, status, and completion together', async () => {
    const ctx = await retainedSource('Phase C final loses'), entered = deferred(), release = deferred();
    const audit = app.get(AuditLogService), log = audit.log.bind(audit);
    const spy = jest.spyOn(audit, 'log').mockImplementation(async (input, tx) => {
      const result = await log(input, tx);
      if (input.action === 'EXTRACT_DOCUMENT' && input.entityId === ctx.documentId) { entered.resolve(); await release.promise; }
      return result;
    });
    const pending = ctx.extract(); await entered.promise;
    try {
      expect(await prisma.documentExtraction.count({ where: { documentId: ctx.documentId } })).toBe(0);
      expect((await ctx.withdraw()).status).toBe(201); release.resolve(); expect((await pending).status).toBe(403); await expectFenced(ctx);
    } finally { release.resolve(); await pending; spy.mockRestore(); }
  });

  it('Phase C concurrent supported deletion wins while storage work holds no document transaction', async () => {
    const ctx = await retainedSource('Phase C deletion'), pause = await pausedRead(ctx);
    try {
      await request(app.getHttpServer()).delete(`/api/documents/${ctx.documentId}`).set(authHeader(ctx.customer.accessToken)).expect(200);
      pause.release(); expect((await pause.pending).status).toBe(404); await expectFenced(ctx);
      expect(await prisma.document.count({ where: { id: ctx.documentId } })).toBe(0);
    } finally { pause.release(); await pause.pending; pause.restore(); }
  });

  it('Phase C provider error retires exactly one dispatch and explicit retry creates a new attempt', async () => withProviderConfiguration(async () => {
    const ctx = await providerSource('Phase C provider failure');
    provider.mockRejectedValueOnce(new Error('Synthetic provider transport outcome unknown'));
    expect((await ctx.extract()).status).toBe(500); expect(provider).toHaveBeenCalledTimes(1); await expectFenced(ctx);
    expect(await prisma.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_DOCUMENT_FAILED' } })).toBe(1);
    expect((await ctx.extract()).status).toBe(201); expect(provider).toHaveBeenCalledTimes(2);
    expect(await prisma.aIJob.count({ where: { documentId: ctx.documentId } })).toBe(2);
    expect(await prisma.aIJob.count({ where: { documentId: ctx.documentId, status: 'COMPLETED' } })).toBe(1);
  }));

  it('Phase C AI withdrawal after dispatch cancels best-effort and fences provider results independently', async () => withProviderConfiguration(async () => {
    const ctx = await providerSource('Phase C AI withdrawal'), entered = deferred(), release = deferred();
    const platform = await createPlatformAdmin('Phase C AI withdrawal admin');
    provider.mockImplementation(async () => { entered.resolve(); await release.promise; return { output_text: JSON.stringify({ activities: [] }) }; });
    const pending = ctx.extract(); await entered.promise;
    try {
      await app.get(AiAuthorizationService).withdraw(ctx.organization.id, platform.user.id, 'SYNTHETIC_PHASE_C');
      release.resolve(); const response = await pending;
      expect(response.status).toBe(403); expect(response.body.code).toBe('AI_AUTHORIZATION_REQUIRED');
      expect(provider).toHaveBeenCalledTimes(1); await expectFenced(ctx);
      expect((await prisma.organizationRealDataAuthorization.findUniqueOrThrow({ where: { organizationId: ctx.organization.id } })).status).toBe('REAL_DATA_APPROVED');
    } finally { release.resolve(); await pending; }
  }));

  it('Phase C stale finalization and failure cleanup cannot overwrite a newer successful attempt', async () => {
    const ctx = await retainedSource('Phase C stale cleanup');
    const old = await admitForInspection(ctx.organization.id, ctx.documentId);
    await prisma.aIJob.update({ where: { id: old.operation.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    expect((await ctx.extract()).status).toBe(201);
    const before = await ctx.state();
    await expect(prisma.$transaction(tx => admissions().finalize(tx, ctx.organization.id, ctx.documentId, old.operation.id, async () => { throw new Error('Must not run stale work'); }))).rejects.toMatchObject({ status: 409 });
    await prisma.$transaction(tx => admissions().fail(tx, ctx.organization.id, ctx.documentId, old.operation.id, async () => { throw new Error('Must not run stale cleanup'); }));
    expect(await ctx.state()).toEqual(before);
  });

  it('Phase C dispatch audit failure rolls back admission and makes zero provider calls', async () => withProviderConfiguration(async () => {
    const ctx = await providerSource('Phase C dispatch audit rollback');
    const audit = app.get(AuditLogService), log = audit.log.bind(audit);
    const spy = jest.spyOn(audit, 'log').mockImplementation(async (input, tx) => {
      if (input.entityId === ctx.documentId && input.action === 'EXTRACT_PROVIDER_DISPATCH_ADMITTED') throw new Error('Synthetic required dispatch audit failure');
      return log(input, tx);
    });
    try {
      expect((await ctx.extract()).status).toBe(500); expect(provider).not.toHaveBeenCalled(); await expectFenced(ctx);
      const job = await prisma.aIJob.findFirstOrThrow({ where: { documentId: ctx.documentId } });
      expect(job.inputJson).toMatchObject({ phase: 'ADMITTED' }); expect(job.status).toBe('FAILED');
      expect(await prisma.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_PROVIDER_DISPATCH_ADMITTED' } })).toBe(0);
    } finally { spy.mockRestore(); }
    expect((await ctx.extract()).status).toBe(201); expect(provider).toHaveBeenCalledTimes(1);
  }));

});

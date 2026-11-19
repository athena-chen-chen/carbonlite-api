import { HttpException, INestApplication } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { postgresAckProxy } from './helpers/postgres-ack-proxy';
import { controlProcess } from './helpers/control-process';
import { assertSafeTestDatabaseTarget } from './helpers/database-safety';
import { verifyPoolIdentity } from '../src/prisma/pool-identity';
import { prototypePoolConfiguration, prototypePoolOptions } from '../src/prisma/control-pool.configuration';
import { PrismaClient, Prisma } from '@prisma/client';
import request from 'supertest';
import { createE2eApp } from './helpers/e2e-app';
import { authHeader, cleanupTestData, createTestUser, uniqueTestId } from './helpers/factories';
import { PrismaService } from '../src/prisma/prisma.service';
import { ControlAdmissionService } from '../src/prisma/control-admission.service';
import { ControlDatabaseService } from '../src/prisma/control-database.service';
import { FacilitiesService } from '../src/facilities/facilities.service';
import { RealDataAuthorizationService } from '../src/real-data-authorization/real-data-authorization.service';
import { ExtractionOperationsService } from '../src/document-extraction/extraction-operations.service';
import { AuditLogService } from '../src/audit-log/audit-log.service';
import { DOCUMENT_STORAGE, DocumentStorage } from '../src/documents/document-storage';
import { openai } from '../src/openai/openai.client';

function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe('local bounded Work/Control pool prototype', () => {
  let app: INestApplication, work: PrismaService, control: ControlDatabaseService;
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  const run = uniqueTestId('control-pool');
  const decisions: string[] = [];
  const withdrawalLatencyMs: number[] = [];
  const previous = { prototype: process.env.LOCAL_CONTROL_POOL_PROTOTYPE, app: process.env.APP_ENV, node: process.env.NODE_ENV,
    ai: process.env.REAL_DATA_AI_PROCESSING_ENABLED, consent: process.env.CARBONLITE_AI_CONSENT_VERSION };
  const provider = openai.responses.create as jest.Mock;
  const controlClient = () => (control as unknown as { client: PrismaService }).client;

  beforeAll(async () => {
    if (assertSafeTestDatabaseTarget().port !== '55447') throw new Error('Phase D disposable direct PostgreSQL fixture required on port 55447');
    process.env.LOCAL_CONTROL_POOL_PROTOTYPE = 'true'; process.env.APP_ENV = 'test'; process.env.NODE_ENV = 'test';
    process.env.REAL_DATA_AI_PROCESSING_ENABLED = 'true'; process.env.CARBONLITE_AI_CONSENT_VERSION = 'real-data-ai-v1';
    ({ app, prisma: work } = await createE2eApp()); control = app.get(ControlDatabaseService);
    admin = await createTestUser(app, { organizationName: `${run} platform`, email: `${uniqueTestId(run)}@carbonlite-e2e.test` });
    await work.user.update({ where: { id: admin.user.id }, data: { role: 'ADMIN', accountType: 'INTERNAL' } });
  });
  afterEach(() => { jest.restoreAllMocks(); provider.mockReset(); });
  afterAll(async () => {
    try {
      await work.realDataAuthorizationEvidence.deleteMany({ where: { authorizationDecisionId: { in: decisions } } });
      await cleanupTestData(work, run);
    } finally {
      const disconnect = jest.spyOn(controlClient(), '$disconnect');
      console.info('Local prototype withdrawal latency ms (Work=4, Control=2):', withdrawalLatencyMs.map(Math.round));
      await app.close(); expect(disconnect).toHaveBeenCalledTimes(1); disconnect.mockRestore();
      const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
      restore('LOCAL_CONTROL_POOL_PROTOTYPE', previous.prototype); restore('APP_ENV', previous.app); restore('NODE_ENV', previous.node);
      restore('REAL_DATA_AI_PROCESSING_ENABLED', previous.ai); restore('CARBONLITE_AI_CONSENT_VERSION', previous.consent);
    }
  });

  async function customer(label: string) {
    const user = await createTestUser(app, { organizationName: `${run} ${label}`, email: `${uniqueTestId(run)}@carbonlite-e2e.test`, factorProfile: 'reviewed' });
    const organizationId = user.user.organizationId;
    const org = await work.organization.update({ where: { id: organizationId }, data: { customerStatus: 'ACTIVE', provisionedAt: new Date() } });
    await work.user.update({ where: { id: user.user.id }, data: { accountType: 'CUSTOMER', isActive: true } });
    await work.membership.upsert({ where: { userId_organizationId: { userId: user.user.id, organizationId } },
      create: { userId: user.user.id, organizationId, role: 'OWNER' }, update: { role: 'OWNER' } });
    await work.organizationQuota.create({ data: { organizationId, enabled: true, periodDays: 28, uploadLimit: 20, dailyUploadLimit: 3,
      maxFileSizeBytes: 10485760, maxConcurrentExtractions: 1, maxImportRows: 500 } });
    const target = { organizationId, confirmationOrganizationId: organizationId, confirmationOrganizationSlug: org.slug };
    const endpoint = `/api/admin/organizations/${organizationId}/real-data-authorization`;
    const approve = async () => {
      const response = await request(app.getHttpServer()).put(endpoint).set(authHeader(admin.accessToken)).send({ ...target, confirmRealDataApproval: true,
        policyVersion: 'CARBONLITE_ALLOWED_DATA_POLICY_V0_2', agreementEvidenceReference: 'synthetic://control-agreement',
        allowedDataScopeReference: 'synthetic://control-scope', privacySecurityReadinessReference: 'synthetic://control-readiness',
        effectiveAt: new Date(Date.now() - 60000).toISOString() });
      expect(response.status).toBe(200); decisions.push(response.body.authorization.decisionId); return response.body.authorization;
    };
    await approve();
    const withdrawal = { ...target, confirmWithdrawal: true as const, withdrawalReason: 'SYNTHETIC_CONTROL_POOL_TEST' };
    return { user, org, target, withdrawal, approve,
      withdraw: () => request(app.getHttpServer()).post(`${endpoint}/withdraw`).set(authHeader(admin.accessToken)).send(withdrawal).then(r => r),
      suspend: () => request(app.getHttpServer()).post('/api/admin/customer-provisioning/suspend').set(authHeader(admin.accessToken))
        .send({ ...target, confirmSuspend: true, suspensionReason: 'SYNTHETIC_CONTROL_POOL_TEST' }).then(r => r),
    };
  }
  async function source(label: string, pdf = false) {
    const ctx = await customer(label);
    if (pdf) await request(app.getHttpServer()).put(`/api/admin/organizations/${ctx.org.id}/ai-authorization`).set(authHeader(admin.accessToken)).send({
      status: 'ENABLED', consentVersion: 'real-data-ai-v1', provider: 'OPENAI', processingScope: 'DOCUMENT_EXTRACTION', authorizedDataMode: 'REAL_CUSTOMER_DATA', realDataApprovalRevision: 1,
      evidenceReference: 'synthetic://control-ai', authorizedRepresentativeReference: 'synthetic-operator', effectiveAt: new Date(Date.now() - 60000).toISOString(),
    }).expect(200);
    const bytes = pdf ? Buffer.from('%PDF-1.4\n% Synthetic control fixture\n%%EOF\n') : Buffer.from(JSON.stringify([
      { activityType: 'DIESEL', quantity: 1, unit: 'L', recordDate: '2026-03-07', jurisdictionCountry: 'Canada', sourceRow: 2 },
    ]));
    const upload = await request(app.getHttpServer()).post('/api/documents/upload').set(authHeader(ctx.user.accessToken)).set('X-CarbonLite-Data-Mode', 'REAL_CUSTOMER_DATA')
      .field('type', pdf ? 'PDF' : 'SPREADSHEET').attach('file', bytes, { filename: `${uniqueTestId(run)}.${pdf ? 'pdf' : 'json'}`, contentType: pdf ? 'application/pdf' : 'application/json' }).expect(201);
    return { ...ctx, documentId: upload.body.id,
      extract: () => request(app.getHttpServer()).post('/api/document-extraction/extract').set(authHeader(ctx.user.accessToken)).send({ documentId: upload.body.id }).then(r => r) };
  }
  async function saturate(count: number, pool: 'work' | 'control' = 'work') {
    const release = barrier(), entered = Array.from({ length: count }, barrier), clients: Prisma.TransactionClient[] = [];
    const held = entered.map((gate, index) => {
      const callback = async (tx: Prisma.TransactionClient) => { await tx.$queryRaw`SELECT 1`; clients[index] = tx; gate.resolve(); await release.promise; };
      return pool === 'work' ? work.$transaction(callback) : controlClient().$transaction(callback);
    });
    await Promise.race([Promise.all(entered.map(x => x.promise)), Promise.all(held).then(() => { throw new Error('Pool barrier ended before saturation'); })]);
    return { clients, release: async () => { release.resolve(); await Promise.allSettled(held); } };
  }
  async function state(organizationId: string) {
    return { authorization: await work.organizationRealDataAuthorization.findUnique({ where: { organizationId } }),
      evidence: await work.realDataAuthorizationEvidence.findMany({ where: { authorizationDecisionId: { in: decisions } }, orderBy: { id: 'asc' } }),
      audits: await work.auditLog.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }) };
  }
  async function noProtectedCommit(documentId: string) {
    expect(await work.documentExtraction.count({ where: { documentId } })).toBe(0);
    expect(await work.aIJob.count({ where: { documentId, status: 'COMPLETED' } })).toBe(0);
    expect(await work.auditLog.count({ where: { entityId: documentId, action: 'EXTRACT_DOCUMENT' } })).toBe(0);
  }

  it('uses one ordinary client after Facilities consolidation and resumes ordinary queries', async () => {
    expect((app.get(FacilitiesService) as unknown as { prisma: PrismaService }).prisma).toBe(work);
    expect(controlClient()).not.toBe(work); expect(control.enabled).toBe(true);
    await request(app.getHttpServer()).get('/api/auth/me').set(authHeader(admin.accessToken)).expect(200);
    await request(app.getHttpServer()).get('/api/facilities').set(authHeader(admin.accessToken)).expect(200);
  });

  it('reserves exactly two control connections alongside four saturated work connections', async () => {
    const workSlots = await saturate(4), controlSlots = await saturate(2, 'control');
    try {
      const pids = await Promise.all([...workSlots.clients, ...controlSlots.clients].map(async tx => (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid));
      expect(new Set(pids).size).toBe(6);
      const counts = await workSlots.clients[0].$queryRaw<Array<{ application_name: string; count: bigint }>>`
        SELECT application_name, count(*) FROM pg_stat_activity
        WHERE pid IN (${Prisma.join(pids)}) GROUP BY application_name`;
      expect(Object.fromEntries(counts.map(x => [x.application_name, Number(x.count)]))).toEqual({ 'carbonlite-local-work': 4, 'carbonlite-local-control': 2 });
    } finally { await workSlots.release(); await controlSlots.release(); }
  });

  it('authenticates and durably withdraws while all four Work Pool connections stay held', async () => {
    const ctx = await customer('saturated withdrawal'), slots = await saturate(4);
    const rootAuth = jest.spyOn(work.user, 'findFirst').mockRejectedValue(new Error('Control authentication must not use Work Pool'));
    try {
      const start = performance.now(), response = await ctx.withdraw();
      expect(response.status).toBe(201); expect(response.body.result).toBe('WITHDRAWN');
      withdrawalLatencyMs.push(performance.now() - start); expect(performance.now() - start).toBeLessThan(1000); expect(rootAuth).not.toHaveBeenCalled();
    } finally { rootAuth.mockRestore(); await slots.release(); }
    const after = await state(ctx.org.id); expect(after.authorization?.status).toBe('WITHDRAWN');
    expect(after.audits.filter(x => x.action === 'REAL_DATA_AUTHORIZATION_WITHDRAWN')).toHaveLength(1);
    expect(await work.user.findFirst({ where: { id: admin.user.id } })).not.toBeNull();
  });

  it.each(['storage', 'provider'] as const)('withdrawal commits while %s work stays blocked and Work Pool is full', async kind => {
    const ctx = await source('blocked ' + kind, kind === 'provider'), entered = barrier(), release = barrier();
    let storageSpy: jest.SpyInstance | undefined;
    if (kind === 'storage') {
      const storage = app.get<DocumentStorage>(DOCUMENT_STORAGE), read = storage.read.bind(storage);
      storageSpy = jest.spyOn(storage, 'read').mockImplementation(async key => { const bytes = await read(key); entered.resolve(); await release.promise; return bytes; });
    } else provider.mockImplementation(async () => { entered.resolve(); await release.promise; return { output_text: JSON.stringify({ activities: [] }) }; });
    const pending = ctx.extract();
    await Promise.race([entered.promise, pending.then(r => { throw new Error('Extraction ended before barrier: ' + r.status); })]);
    const slots = await saturate(4);
    try { const start = performance.now(); expect((await ctx.withdraw()).status).toBe(201); withdrawalLatencyMs.push(performance.now() - start); expect(performance.now() - start).toBeLessThan(1000); }
    finally { await slots.release(); release.resolve(); }
    try { expect((await pending).status).toBe(403); await noProtectedCommit(ctx.documentId); expect(provider).toHaveBeenCalledTimes(kind === 'provider' ? 1 : 0); }
    finally { storageSpy?.mockRestore(); }
  });

  it('withdrawal wins while prepared final writes are pending and all Work connections are occupied', async () => {
    const ctx = await source('late final fence'), entered = barrier(), release = barrier();
    const operations = app.get(ExtractionOperationsService), validate = operations.lockAndValidate.bind(operations);
    const spy = jest.spyOn(operations, 'lockAndValidate').mockImplementation(async (...args) => { entered.resolve(); await release.promise; return validate(...args); });
    const pending = ctx.extract(); await entered.promise;
    const slots = await saturate(3);
    try { expect((await ctx.withdraw()).status).toBe(201); }
    finally { await slots.release(); release.resolve(); }
    expect((await pending).status).toBe(403); await noProtectedCommit(ctx.documentId); spy.mockRestore();
  });

  it('returns bounded fence contention without claiming withdrawal when final fencing wins', async () => {
    const ctx = await source('fence contention'), entered = barrier(), release = barrier();
    const real = app.get(RealDataAuthorizationService), lock = real.lockProcessingApproval.bind(real); let shared = 0;
    const spy = jest.spyOn(real, 'lockProcessingApproval').mockImplementation(async (tx, org, sharedLock) => {
      await lock(tx, org, sharedLock);
      if (org === ctx.org.id && sharedLock && ++shared === 2) { entered.resolve(); await release.promise; }
    });
    const pending = ctx.extract(); await entered.promise;
    try {
      const start = performance.now(), response = await ctx.withdraw();
      expect(response.status).toBe(503); expect(response.body).toMatchObject({ code: 'CONTROL_FENCE_BUSY', outcome: 'NOT_COMMITTED', automaticRetry: false });
      expect(performance.now() - start).toBeLessThan(1000);
      expect((await state(ctx.org.id)).authorization?.status).toBe('REAL_DATA_APPROVED');
    } finally { release.resolve(); }
    expect((await pending).status).toBe(201); spy.mockRestore();
    expect((await ctx.withdraw()).status).toBe(201); // New explicit submission after authoritative reconciliation.
  });

  it('suspends atomically without nested acquisition while Work Pool is saturated', async () => {
    const ctx = await source('suspension', true), entered = barrier(), release = barrier();
    provider.mockImplementation(async () => { entered.resolve(); await release.promise; return { output_text: JSON.stringify({ activities: [] }) }; });
    const pending = ctx.extract(); await entered.promise;
    const slots = await saturate(4);
    const rootTransaction = jest.spyOn(work, '$transaction').mockRejectedValue(new Error('No Work Pool nesting allowed'));
    try { expect((await ctx.suspend()).status).toBe(201); expect(rootTransaction).not.toHaveBeenCalled(); }
    finally { rootTransaction.mockRestore(); await slots.release(); release.resolve(); }
    expect((await pending).status).toBe(403); await noProtectedCommit(ctx.documentId);
    expect(await work.organization.findUnique({ where: { id: ctx.org.id } })).toMatchObject({ customerStatus: 'SUSPENDED' });
    expect((await state(ctx.org.id)).authorization?.status).toBe('WITHDRAWN');
    expect(await work.organizationAiAuthorization.findUnique({ where: { organizationId: ctx.org.id } })).toMatchObject({ status: 'WITHDRAWN' });
    expect((await ctx.extract()).status).toBe(401); expect(provider).toHaveBeenCalledTimes(1); // Suspended live accounts fail authentication.
  });

  it('bounds Control Pool acquisition failure and never falls back to Work', async () => {
    const ctx = await customer('control capacity'), before = await state(ctx.org.id), slots = await saturate(2, 'control');
    try {
      const start = performance.now(), response = await ctx.withdraw();
      expect(response.status).toBe(503); expect(response.body).toMatchObject({ code: 'CONTROL_CAPACITY_UNAVAILABLE', outcome: 'NOT_COMMITTED', automaticRetry: false });
      expect(performance.now() - start).toBeLessThan(1000);
    } finally { await slots.release(); }
    expect(await state(ctx.org.id)).toEqual(before);
  });

  it('keeps cross-tenant and live-role checks while Work Pool is saturated', async () => {
    const a = await customer('tenant A'), b = await customer('tenant B'), before = await state(b.org.id), slots = await saturate(4);
    try {
      await request(app.getHttpServer()).post(`/api/admin/organizations/${b.org.id}/real-data-authorization/withdraw`).set(authHeader(a.user.accessToken)).send(b.withdrawal).expect(403);
      await request(app.getHttpServer()).post(`/api/admin/organizations/${b.org.id}/real-data-authorization/withdraw`).set(authHeader(admin.accessToken))
        .send({ ...b.withdrawal, confirmationOrganizationId: a.org.id }).expect(400);
    } finally { await slots.release(); }
    expect(await state(b.org.id)).toEqual(before);
  });

  it('rolls back authorization, bound AI withdrawal and evidence when required audit fails', async () => {
    const ctx = await source('required audit', true), before = await state(ctx.org.id);
    const audit = app.get(AuditLogService), log = audit.log.bind(audit);
    jest.spyOn(audit, 'log').mockImplementation(async (input, tx) => {
      if (input.action === 'REAL_DATA_AUTHORIZATION_WITHDRAWN' && input.organizationId === ctx.org.id) throw new Error('Synthetic required audit failure');
      return log(input, tx);
    });
    expect((await ctx.withdraw()).status).toBe(500); expect(await state(ctx.org.id)).toEqual(before);
    expect(await work.organizationAiAuthorization.findUnique({ where: { organizationId: ctx.org.id } })).toMatchObject({ status: 'ENABLED' });
  });

  it('requires reconciliation after a lost commit acknowledgement and performs no automatic retry', async () => {
    const ctx = await customer('ambiguous commit'); const client = controlClient(), transaction = client.$transaction.bind(client);
    const spy = jest.spyOn(client, '$transaction').mockImplementation((async (...args: any[]) => { await (transaction as any)(...args); throw new Error('Synthetic lost commit acknowledgement'); }) as any);
    try { await expect(app.get(RealDataAuthorizationService).withdraw(ctx.org.id, admin.user.id, ctx.withdrawal)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONTROL_OUTCOME_UNCERTAIN', reconciliationRequired: true, automaticRetry: false }) }); expect(spy).toHaveBeenCalledTimes(1); }
    finally { spy.mockRestore(); }
    const after = await state(ctx.org.id); expect(after.authorization?.status).toBe('WITHDRAWN');
    expect(after.audits.filter(x => x.action === 'REAL_DATA_AUTHORIZATION_WITHDRAWN')).toHaveLength(1);
  });



  it('fences only the withdrawn tenant when two provider operations are in flight', async () => {
    const a = await source('parallel A', true), b = await source('parallel B', true), entered = barrier(), release = barrier(); let arrivals = 0;
    provider.mockImplementation(async () => { if (++arrivals === 2) entered.resolve(); await release.promise; return { output_text: JSON.stringify({ activities: [] }) }; });
    const first = a.extract(), second = b.extract();
    await Promise.race([entered.promise, Promise.all([first, second]).then(() => { throw new Error('Provider barrier was not reached'); })]);
    const slots = await saturate(4);
    try { expect((await a.withdraw()).status).toBe(201); }
    finally { await slots.release(); release.resolve(); }
    expect((await first).status).toBe(403); expect((await second).status).toBe(201);
    await noProtectedCommit(a.documentId);
    expect(await work.aIJob.count({ where: { documentId: b.documentId, status: 'COMPLETED' } })).toBe(1);
    expect((await state(b.org.id)).authorization?.status).toBe('REAL_DATA_APPROVED'); expect(provider).toHaveBeenCalledTimes(2);
  });

  it('does not route ordinary authentication onto the Control Pool', async () => {
    const authenticate = jest.spyOn(control, 'authenticate');
    await request(app.getHttpServer()).get('/api/auth/me').set(authHeader(admin.accessToken)).expect(200);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('withdraws AI authorization through isolated authentication and its owning Control transaction', async () => {
    const ctx = await source('explicit AI withdrawal', true), slots = await saturate(4);
    const rootAuth = jest.spyOn(work.user, 'findFirst').mockRejectedValue(new Error('Unexpected Work authentication'));
    try {
      await request(app.getHttpServer()).post(`/api/admin/organizations/${ctx.org.id}/ai-authorization/withdraw`)
        .set(authHeader(admin.accessToken)).send({ withdrawalReference: 'synthetic://explicit-control-withdrawal' }).expect(201);
      expect(rootAuth).not.toHaveBeenCalled();
    } finally { rootAuth.mockRestore(); await slots.release(); }
    expect(await work.organizationAiAuthorization.findUnique({ where: { organizationId: ctx.org.id } })).toMatchObject({ status: 'WITHDRAWN' });
    expect((await state(ctx.org.id)).authorization?.status).toBe('REAL_DATA_APPROVED');
    expect(await work.auditLog.count({ where: { organizationId: ctx.org.id, action: 'AI_AUTHORIZATION_WITHDRAWN' } })).toBe(1);
    expect(provider).not.toHaveBeenCalled();
  });

  it('rolls back a withdrawal at the five-second transaction budget', async () => {
    const ctx = await customer('transaction timeout'), before = await state(ctx.org.id), entered = barrier(), release = barrier();
    const audit = app.get(AuditLogService), log = audit.log.bind(audit); let pid = 0;
    jest.spyOn(audit, 'log').mockImplementation(async (input, tx) => {
      const result = await log(input, tx);
      if (input.action === 'REAL_DATA_AUTHORIZATION_WITHDRAWN' && input.organizationId === ctx.org.id) {
        const rows = await (tx as Prisma.TransactionClient).$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; pid = rows[0].pid;
        entered.resolve(); await release.promise;
      }
      return result;
    });
    const started = performance.now(), pending = ctx.withdraw(); await entered.promise;
    try {
      // PostgreSQL state, rather than a sleep, determines when Prisma's transaction
      // has rolled back. The callback remains deliberately blocked until then.
      const until = Date.now() + 6500; let ended = false;
      while (Date.now() < until) {
        const rows = await work.$queryRaw<Array<{ ended: boolean }>>`SELECT xact_start IS NULL AS ended FROM pg_stat_activity WHERE pid = ${pid}`;
        if (!rows.length || rows[0].ended) { ended = true; break; }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(ended).toBe(true);
    } finally { release.resolve(); }
    const response = await pending;
    expect(response.status).toBe(503); expect(response.body).toMatchObject({ code: 'CONTROL_TRANSACTION_TIMEOUT', outcome: 'NOT_COMMITTED', automaticRetry: false });
    expect(performance.now() - started).toBeLessThan(6000);
    expect(await state(ctx.org.id)).toEqual(before);
  });

  it('returns an uncertain request deadline without late commit or automatic retry', async () => {
    const ctx = await customer('request deadline'), before = await state(ctx.org.id), entered = barrier(), release = barrier(), settled = barrier();
    const audit = app.get(AuditLogService), log = audit.log.bind(audit);
    jest.spyOn(audit, 'log').mockImplementation(async (input, tx) => {
      const result = await log(input, tx);
      if (input.action === 'REAL_DATA_AUTHORIZATION_WITHDRAWN' && input.organizationId === ctx.org.id) { entered.resolve(); await release.promise; }
      return result;
    });
    const client = controlClient(), transaction = client.$transaction.bind(client); let calls = 0;
    const spy = jest.spyOn(client, '$transaction').mockImplementation((async (...args: any[]) => {
      const index = ++calls;
      try { return await (transaction as any)(...args); } finally { if (index === 2) settled.resolve(); }
    }) as any);
    const started = performance.now(), pending = ctx.withdraw(); await entered.promise;
    try {
      const response = await pending;
      expect(response.status).toBe(503); expect(response.body).toMatchObject({ code: 'CONTROL_OUTCOME_UNCERTAIN', reconciliationRequired: true, automaticRetry: false });
      expect(performance.now() - started).toBeLessThan(7000); expect(calls).toBe(2);
      expect((await ctx.withdraw()).body.code).toBe('CONTROL_ADMISSION_BUSY'); expect(calls).toBe(2); // One authentication plus one withdrawal.
    } finally { release.resolve(); await settled.promise; spy.mockRestore(); }
    expect(await state(ctx.org.id)).toEqual(before);
  });

  it('rejects the old admitted revision after withdrawal and reapproval', async () => {
    const ctx = await source('reapproval'), operations = app.get(ExtractionOperationsService);
    const old = await operations.admit(ctx.org.id, ctx.documentId); old.release();
    expect((await ctx.withdraw()).status).toBe(201); expect((await ctx.approve()).approvalRevision).toBe(2);
    await expect(work.$transaction(tx => operations.lockAndValidate(tx, ctx.org.id, ctx.documentId, old.operation.id)))
      .rejects.toMatchObject({ status: 403, response: expect.objectContaining({ code: 'REAL_DATA_APPROVAL_REVISION_MISMATCH' }) });
    expect(await work.documentExtraction.count({ where: { documentId: ctx.documentId } })).toBe(0);
  });

  it('rejects wrong database and role identity using real read-only PostgreSQL checks', async () => {
    const config = prototypePoolConfiguration()!;
    await expect(verifyPoolIdentity(work, { ...config, database: 'synthetic_wrong_database' })).rejects.toThrow('identity verification failed');
    await expect(verifyPoolIdentity(work, { ...config, role: 'synthetic_wrong_role' })).rejects.toThrow('identity verification failed');
    await verifyPoolIdentity(work, config);
  });

  it('rejects concurrent control requests without queuing or partial suspension', async () => {
    const ctx = await customer('concurrent control'), entered = barrier(), release = barrier();
    const audit = app.get(AuditLogService), log = audit.log.bind(audit);
    jest.spyOn(audit, 'log').mockImplementation(async (input, tx) => {
      const result = await log(input, tx);
      if (input.organizationId === ctx.org.id && input.action === 'REAL_DATA_AUTHORIZATION_WITHDRAWN') { entered.resolve(); await release.promise; }
      return result;
    });
    const withdrawing = ctx.withdraw(); await entered.promise;
    try {
      const second = await ctx.suspend(); expect(second.status).toBe(503);
      expect(second.body).toMatchObject({ code: 'CONTROL_ADMISSION_BUSY', outcome: 'NOT_COMMITTED', automaticRetry: false });
      expect(await work.auditLog.count({ where: { organizationId: ctx.org.id, action: 'CUSTOMER_ORGANIZATION_SUSPENDED' } })).toBe(0);
    } finally { release.resolve(); }
    expect((await withdrawing).status).toBe(201);
    expect((await state(ctx.org.id)).authorization?.status).toBe('WITHDRAWN');
    expect((await ctx.suspend()).status).toBe(201); // Separate explicit action after reconciliation.
    expect(await work.auditLog.count({ where: { organizationId: ctx.org.id, action: 'REAL_DATA_AUTHORIZATION_WITHDRAWN' } })).toBe(1);
    expect(await work.organization.findUnique({ where: { id: ctx.org.id } })).toMatchObject({ customerStatus: 'SUSPENDED' });
  });

  it('distinguishes upstream PgBouncer exhaustion and recovers without client proliferation', async () => {
    const poolerUrl = process.env.CONTROL_POOL_PGBOUNCER_TEST_URL;
    if (!poolerUrl) throw new Error('Disposable PgBouncer fixture required; no live endpoint fallback');
    assertSafeTestDatabaseTarget(poolerUrl);
    const target = new URL(poolerUrl);
    if (target.port !== '55448') throw new Error('Dedicated disposable pooler port required');
    const client = new PrismaClient(prototypePoolOptions('work', { ...process.env, DATABASE_URL: poolerUrl }));
    const original = process.env.DATABASE_URL; const admission = new ControlAdmissionService(); let isolated: ControlDatabaseService;
    try { process.env.DATABASE_URL = poolerUrl; isolated = new ControlDatabaseService(work, admission); }
    finally { process.env.DATABASE_URL = original; }
    const release = barrier(), entered = [barrier(), barrier()], settled = barrier();
    let held: Promise<unknown>[] = [];
    try {
      await isolated.initializeVerified();
      held = entered.map(gate => client.$transaction(async tx => { await tx.$queryRaw`SELECT 1`; gate.resolve(); await release.promise; }, { timeout: 15000 }));
      await Promise.all(entered.map(gate => gate.promise));
      const actual = (isolated as unknown as { client: PrismaClient }).client, transaction = actual.$transaction.bind(actual);
      const spy = jest.spyOn(actual, '$transaction').mockImplementation((async (...args: any[]) => {
        try { return await (transaction as any)(...args); } finally { settled.resolve(); }
      }) as any);
      let callbackEntered = false;
      const result = isolated.transaction('CONTROL', async tx => { callbackEntered = true; return tx.$queryRaw`SELECT 1`; }).catch(error => error);
      // SHOW POOLS observes the upstream waiting client while two server slots
      // are held. The application's control pool itself has spare capacity.
      let queued = false; const until = Date.now() + 3000;
      while (Date.now() < until && !queued) {
        const { stdout } = await promisify(execFile)('docker', ['exec', '-e', 'PGPASSWORD=postgres', process.env.CONTROL_POOL_TEST_POSTGRES_CONTAINER || 'carbonlite-d-release-pg',
          'psql', '-h', process.env.CONTROL_POOL_TEST_POOLER_HOST || 'carbonlite-d-release-pooler', '-U', 'postgres', '-d', 'pgbouncer', '-At', '-c', 'SHOW POOLS']);
        queued = stdout.split('\n').some(line => { const row = line.split('|'); return row[0] === 'carbonlite_ci_test' && Number(row[3]) > 0 && Number(row[6]) === 2; });
      }
      expect(queued).toBe(true);
      const error = await result;
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getResponse()).toMatchObject({ code: 'CONTROL_OUTCOME_UNCERTAIN', outcome: 'UNKNOWN', reconciliationRequired: true, automaticRetry: false });
      await expect(isolated.transaction('CONTROL', async tx => tx.$queryRaw`SELECT 1`)).rejects.toMatchObject({ response: { code: 'CONTROL_ADMISSION_BUSY' } });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(callbackEntered).toBe(false);
      release.resolve(); await Promise.all(held); await settled.promise; await admission.whenIdle(); spy.mockRestore();
      expect(await isolated.transaction('CONTROL', async tx => tx.$queryRaw`SELECT 1`)).toHaveLength(1);
    } finally { release.resolve(); await Promise.allSettled(held); await isolated!.onModuleDestroy(); await client.$disconnect(); }
  });

  it.each(['before-dispatch', 'after-dispatch', 'before-final', 'after-final'] as const)('recovers durable state after process death at %s', async checkpoint => {
    const ctx = await source('crash ' + checkpoint, checkpoint.includes('dispatch'));
    const child = await controlProcess(checkpoint);
    const response = child.request('document-extraction/extract', ctx.user.accessToken, { documentId: ctx.documentId });
    const event = checkpoint === 'after-dispatch' ? 'provider-accepted' : checkpoint;
    try {
      await child.wait(event);
      const before = await work.aIJob.findFirstOrThrow({ where: { documentId: ctx.documentId } });
      if (checkpoint === 'after-final') expect(before.status).toBe('COMPLETED');
      else { expect(before.status).toBe('RUNNING'); await noProtectedCommit(ctx.documentId); }
      if (checkpoint.includes('dispatch')) {
        expect(before.inputJson).toMatchObject({ phase: checkpoint === 'before-dispatch' ? 'ADMITTED' : 'DISPATCH_ADMITTED' });
        expect(await work.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_PROVIDER_DISPATCH_ADMITTED' } })).toBe(checkpoint === 'after-dispatch' ? 1 : 0);
      }
      await child.kill(); expect((await response).status).toBe(0);
      const restart = await controlProcess('normal');
      try {
        // Startup never resumes provider calls or finalizes an old operation.
        expect(await work.aIJob.findUnique({ where: { id: before.id } })).toEqual(before);
        expect(restart.events.some(value => value.event === 'provider-accepted')).toBe(false);
        if (checkpoint !== 'after-final') {
          await noProtectedCommit(ctx.documentId);
          await work.aIJob.update({ where: { id: before.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
          const retry = await restart.request('document-extraction/extract', ctx.user.accessToken, { documentId: ctx.documentId });
          expect(retry.status).toBe(201);
          expect(await work.aIJob.findUnique({ where: { id: before.id } })).toMatchObject({ status: 'FAILED' });
        }
        expect(await work.aIJob.count({ where: { documentId: ctx.documentId, status: 'COMPLETED' } })).toBe(1);
        expect(await work.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_DOCUMENT' } })).toBe(1);
        restart.child.send({ command: 'finalize', organizationId: ctx.org.id, documentId: ctx.documentId, operationId: before.id });
        expect((await restart.wait('fence-denied')).status).toBe(409);
        expect(restart.events.some(value => value.event === 'unsafe-finalization')).toBe(false);
      } finally { await restart.kill(); }
    } finally { await child.kill(); await response; }
  });

  it('drains an in-flight withdrawal on SIGTERM before disconnecting Control', async () => {
    const ctx = await customer('shutdown'), child = await controlProcess('shutdown');
    const pending = child.request(`admin/organizations/${ctx.org.id}/real-data-authorization/withdraw`, admin.accessToken, ctx.withdrawal);
    try {
      await child.wait('withdrawal-prepared'); child.child.kill('SIGTERM'); await child.wait('draining');
      child.child.send('release'); expect((await pending).status).toBe(201); await child.exited;
      expect((await state(ctx.org.id)).authorization?.status).toBe('WITHDRAWN');
      expect(await work.auditLog.count({ where: { organizationId: ctx.org.id, action: 'REAL_DATA_AUTHORIZATION_WITHDRAWN' } })).toBe(1);
    } finally { await child.kill(); await pending; }
  });

  it('accounts for twelve distinct connections across two overlapping application processes', async () => {
    const a = await controlProcess('normal'), b = await controlProcess('normal');
    try {
      a.child.send('hold-pools'); b.child.send('hold-pools');
      const pids: number[] = [];
      for (let index = 0; index < 6; ++index) pids.push((await a.wait('connection-held')).pid!, (await b.wait('connection-held')).pid!);
      expect(new Set(pids).size).toBe(12);
      const rows = await work.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE pid IN (${Prisma.join(pids)})`;
      expect(Number(rows[0].count)).toBe(12);
      a.child.send('release'); b.child.send('release'); await a.wait('pools-released'); await b.wait('pools-released');
    } finally { await a.kill(); await b.kill(); }
  });

  it('reports ambiguity when a real PostgreSQL COMMIT acknowledgement is dropped', async () => {
    const ctx = await customer('wire commit acknowledgement'), proxy = await postgresAckProxy();
    const original = process.env.DATABASE_URL, url = new URL(original!); url.port = String(proxy.port); url.searchParams.set('sslmode', 'disable');
    let isolated: ControlDatabaseService;
    try { process.env.DATABASE_URL = url.toString(); isolated = new ControlDatabaseService(work); }
    finally { process.env.DATABASE_URL = original; }
    try {
      await isolated.initializeVerified(); proxy.arm();
      const service = new RealDataAuthorizationService(work, app.get(AuditLogService), isolated);
      await expect(service.withdraw(ctx.org.id, admin.user.id, ctx.withdrawal)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CONTROL_OUTCOME_UNCERTAIN', reconciliationRequired: true, automaticRetry: false }),
      });
      await proxy.lost;
      expect((await state(ctx.org.id)).authorization?.status).toBe('WITHDRAWN');
      expect(await work.auditLog.count({ where: { organizationId: ctx.org.id, action: 'REAL_DATA_AUTHORIZATION_WITHDRAWN' } })).toBe(1);
    } finally { await proxy.close(); await isolated!.onModuleDestroy(); }
  });

});

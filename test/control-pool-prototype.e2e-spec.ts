import { createServer, connect, type Socket } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { HttpException, INestApplication } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import * as identityVerifier from '../src/prisma/pool-identity';
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
import { AiAuthorizationService } from '../src/ai-authorization/ai-authorization.service';
import { RealDataAuthorizationService } from '../src/real-data-authorization/real-data-authorization.service';
import { ExtractionOperationsService } from '../src/document-extraction/extraction-operations.service';
import { AuditLogService } from '../src/audit-log/audit-log.service';
import { DOCUMENT_STORAGE, DocumentStorage, documentStorageKey } from '../src/documents/document-storage';
import { openai } from '../src/openai/openai.client';

function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe('local bounded Work/Control pool prototype', () => {
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  let app: INestApplication, work: PrismaService, control: ControlDatabaseService;
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  const run = uniqueTestId('control-pool');
  const decisions: string[] = [];
  const phaseEQuarantineKeys: string[] = [];
  const withdrawalLatencyMs: number[] = [];
  const previous = { prototype: process.env.LOCAL_CONTROL_POOL_PROTOTYPE, app: process.env.APP_ENV, node: process.env.NODE_ENV,
    ai: process.env.REAL_DATA_AI_PROCESSING_ENABLED, consent: process.env.CARBONLITE_AI_CONSENT_VERSION };
  const provider = openai.responses.create as jest.Mock;
  const controlClient = () => (control as unknown as { client: PrismaService }).client;

  beforeAll(async () => {
    eventLoop.enable();
    if (assertSafeTestDatabaseTarget().port !== '55447') throw new Error('Phase D disposable direct PostgreSQL fixture required on port 55447');
    process.env.LOCAL_CONTROL_POOL_PROTOTYPE = 'true'; process.env.APP_ENV = 'test'; process.env.NODE_ENV = 'test';
    process.env.REAL_DATA_AI_PROCESSING_ENABLED = 'true'; process.env.CARBONLITE_AI_CONSENT_VERSION = 'real-data-ai-v1';
    ({ app, prisma: work } = await createE2eApp()); control = app.get(ControlDatabaseService);
    admin = await createTestUser(app, { organizationName: `${run} platform`, email: `${uniqueTestId(run)}@carbonlite-e2e.test` });
    await work.user.update({ where: { id: admin.user.id }, data: { role: 'ADMIN', accountType: 'INTERNAL' } });
  });
  afterEach(() => { jest.restoreAllMocks(); provider.mockReset(); });
  afterAll(async () => {
    eventLoop.disable(); console.info('Disposable suite scheduling diagnostics', { meanMs: Math.round(eventLoop.mean / 1e6), maxMs: Math.round(eventLoop.max / 1e6), p99Ms: Math.round(eventLoop.percentile(99) / 1e6), rssMiB: Math.round(process.memoryUsage().rss / 1048576) });
    try {
      const storage = app.get<DocumentStorage>(DOCUMENT_STORAGE);
      for (const key of phaseEQuarantineKeys) if (await storage.quarantineExists(key)) await storage.purgeQuarantine(key);
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

  async function customer(label: string, approveInitial = true) {
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
    if (approveInitial) await approve();
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

  it.each(['work', 'control'] as const)('uses actual %s client configuration through a delayed startup handshake', async kind => {
    await connectionBudgetStartup(kind, false);
  });
  it.each(['work', 'control'] as const)('bounds an unavailable %s startup and disconnects without retry', async kind => {
    await connectionBudgetStartup(kind, true);
  });
  async function connectionBudgetStartup(kind: 'work' | 'control', unavailable: boolean) {
    const sockets = new Set<Socket>(), timers = new Set<ReturnType<typeof setTimeout>>();
    // Fault injection delays the PostgreSQL handshake, not application scheduling.
    const proxy = createServer(socket => {
      sockets.add(socket); socket.pause(); socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
      if (unavailable) return;
      const timer = setTimeout(() => {
        timers.delete(timer); if (socket.destroyed) return;
        const upstream = connect(55447, '127.0.0.1', () => { socket.pipe(upstream); upstream.pipe(socket); socket.resume(); });
        sockets.add(upstream); upstream.on('error', () => socket.destroy());
        upstream.on('close', () => sockets.delete(upstream)); socket.on('close', () => upstream.destroy());
      }, 1200);
      timers.add(timer);
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('Disposable proxy address required');
    const original = process.env.DATABASE_URL, target = new URL(original!); target.port = String(address.port);
    let candidate: PrismaService | ControlDatabaseService;
    try { process.env.DATABASE_URL = target.toString(); candidate = kind === 'work' ? new PrismaService() : new ControlDatabaseService(work, new ControlAdmissionService()); }
    finally { process.env.DATABASE_URL = original; }
    const actual = kind === 'work' ? candidate! as PrismaService : (candidate! as unknown as { client: PrismaClient }).client;
    const connection = jest.spyOn(actual, '$connect'), disconnect = jest.spyOn(actual, '$disconnect');
    const start = performance.now();
    try {
      if (unavailable) {
        await expect(candidate!.initializeVerified()).rejects.toThrow('activation failed');
        const elapsed = performance.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(4500); expect(elapsed).toBeLessThan(6500);
        await expect(candidate!.initializeVerified()).rejects.toThrow('activation failed');
        expect(disconnect).toHaveBeenCalledTimes(1);
      } else {
        await candidate!.initializeVerified();
        expect(performance.now() - start).toBeGreaterThanOrEqual(1200);
        expect(await actual.$queryRaw`SELECT current_database() AS database`).toEqual([{ database: 'carbonlite_ci_test' }]);
      }
      expect(connection).toHaveBeenCalledTimes(1);
    } finally {
      await candidate!.onModuleDestroy();
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  }

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
        // A returned callback is deliberately classified UNKNOWN. Prove this
        // known-rollback case by observing the expired transaction in the callback
        // itself, not only in an external pg_stat_activity poll.
        const resumed = performance.now();
        try { await (tx as Prisma.TransactionClient).$queryRaw`SELECT 1`; }
        catch (error) { console.info('Known rollback callback settlement', { rejected: true, resumedMs: Math.round(performance.now() - resumed), code: (error as { code?: string }).code }); throw error; }
        throw new Error('Expired control transaction unexpectedly remained usable');
      }
      return result;
    });
    const startedWall = Date.now(), started = performance.now(), pending = ctx.withdraw(); await entered.promise;
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
    console.info('Control timeout response timing', { elapsedMs: Math.round(performance.now() - started), wallElapsedMs: Date.now() - startedWall, code: response.body.code });
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

  async function committedExtraction(documentId: string) {
    const job = await work.aIJob.findFirstOrThrow({ where: { documentId }, orderBy: { createdAt: 'desc' } });
    expect(job).toMatchObject({ status: 'COMPLETED', leaseExpiresAt: null });
    const document = await work.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe('REVIEW_REQUIRED');
    const extraction = await work.documentExtraction.findFirstOrThrow({ where: { documentId } });
    expect(await work.auditLog.count({ where: { entityId: documentId, action: 'EXTRACT_DOCUMENT' } })).toBe(1);
    expect(await work.userActivityEvent.count({ where: { entityId: documentId, eventName: 'DOCUMENT_EXTRACT_SUCCEEDED' } })).toBe(1);
    expect(await work.userActivityEvent.count({ where: { entityId: documentId, eventName: 'DOCUMENT_EXTRACT_FAILED' } })).toBe(0);
    return { job, document, extraction };
  }

  it.each([false, true])('Phase E final-result COMMIT acknowledgement loss is truthful and reconciles after restart: provider=%s', async pdf => {
    const ctx = await source('Phase E final ack ' + pdf, pdf), proxy = await postgresAckProxy();
    const url = new URL(process.env.DATABASE_URL!); url.port = String(proxy.port);
    const child = await controlProcess('final-ack', { DATABASE_URL: url.toString() });
    const pending = child.request('document-extraction/extract', ctx.user.accessToken, { documentId: ctx.documentId });
    try {
      await child.wait('final-ack'); proxy.arm(); child.child.send('release'); await proxy.lost;
      const response = await pending;
      const before = await committedExtraction(ctx.documentId);
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ code: 'EXTRACTION_OUTCOME_UNCERTAIN', outcome: 'UNKNOWN', reconciliationRequired: true, automaticRetry: false });
      await child.kill(); const restarted = await controlProcess('normal');
      try {
        expect(await committedExtraction(ctx.documentId)).toEqual(before);
        expect(restarted.events.some(event => event.event === 'provider-accepted')).toBe(false);
        expect(await work.aIJob.count({ where: { documentId: ctx.documentId } })).toBe(1);
      } finally { await restarted.kill(); }
    } finally { await child.kill(); await pending; await proxy.close(); }
  });

  it.each(['dispatch-before-send', 'after-provider-response'] as const)('Phase E provider boundary %s cannot publish after downtime withdrawal', async checkpoint => {
    const ctx = await source('Phase E ' + checkpoint, true), child = await controlProcess(checkpoint);
    const pending = child.request('document-extraction/extract', ctx.user.accessToken, { documentId: ctx.documentId });
    try {
      await child.wait(checkpoint === 'dispatch-before-send' ? checkpoint : 'response-before-persistence');
      const old = await work.aIJob.findFirstOrThrow({ where: { documentId: ctx.documentId } });
      expect(old.inputJson).toMatchObject({ phase: 'DISPATCH_ADMITTED', organizationId: ctx.org.id, approvalRevision: 1 });
      expect(await work.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_PROVIDER_DISPATCH_ADMITTED' } })).toBe(1);
      if (checkpoint === 'dispatch-before-send') expect(child.events.some(event => event.event === 'provider-accepted')).toBe(false);
      else await child.wait('provider-accepted');
      await noProtectedCommit(ctx.documentId); await child.kill(); await pending;
      expect((await ctx.withdraw()).status).toBe(201);
      const restarted = await controlProcess('normal');
      try {
        restarted.child.send({ command: 'finalize-probe', organizationId: ctx.org.id, documentId: ctx.documentId, operationId: old.id });
        await restarted.wait('provisional-prepared');
        expect(await restarted.wait('fence-denied')).toMatchObject({ status: 403, code: 'REAL_DATA_NOT_AUTHORIZED' });
        expect(await work.userActivityEvent.count({ where: { entityId: ctx.documentId, eventName: 'PHASE_E_PROVISIONAL' } })).toBe(0);
        await work.aIJob.update({ where: { id: old.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
        restarted.child.send({ command: 'finalize', organizationId: ctx.org.id, documentId: ctx.documentId, operationId: old.id });
        expect((await restarted.wait('fence-denied')).status).toBe(409);
        expect((await restarted.request('document-extraction/extract', ctx.user.accessToken, { documentId: ctx.documentId })).status).toBe(403);
        expect(restarted.events.some(event => event.event === 'provider-accepted' || event.event === 'unsafe-finalization')).toBe(false);
        await noProtectedCommit(ctx.documentId);
        expect(await work.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_PROVIDER_DISPATCH_ADMITTED' } })).toBe(1);
      } finally { await restarted.kill(); }
    } finally { await child.kill(); await pending; }
  });

  it('Phase E lease expiry during downtime fences old decisions and preserves a newer result', async () => {
    const ctx = await source('Phase E downtime lease'), oldWorker = await controlProcess('before-final');
    const oldRequest = oldWorker.request('document-extraction/extract', ctx.user.accessToken, { documentId: ctx.documentId });
    try {
      await oldWorker.wait('before-final'); const old = await work.aIJob.findFirstOrThrow({ where: { documentId: ctx.documentId } });
      await oldWorker.kill(); await oldRequest;
      const restart = await controlProcess('normal');
      try {
        const beforeExpiry = await restart.request('document-extraction/extract', ctx.user.accessToken, { documentId: ctx.documentId });
        expect(beforeExpiry.status).toBe(409); expect(await work.aIJob.count({ where: { documentId: ctx.documentId } })).toBe(1);
      } finally { await restart.kill(); }
      expect((await ctx.withdraw()).status).toBe(201); const newer = await ctx.approve(); expect(newer.approvalRevision).toBe(2);
      expect(newer.decisionId).not.toBe((old.inputJson as Prisma.JsonObject).realDataDecisionId);
      // Deterministic test-only clock transition occurs while no worker exists.
      await work.aIJob.update({ where: { id: old.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
      const afterExpiry = await controlProcess('normal');
      try {
        expect((await afterExpiry.request('document-extraction/extract', ctx.user.accessToken, { documentId: ctx.documentId })).status).toBe(201);
        const completed = await committedExtraction(ctx.documentId);
        afterExpiry.child.send({ command: 'finalize', organizationId: ctx.org.id, documentId: ctx.documentId, operationId: old.id });
        expect((await afterExpiry.wait('fence-denied')).status).toBe(409);
        expect(await committedExtraction(ctx.documentId)).toEqual(completed);
        expect((completed.job.inputJson as Prisma.JsonObject).approvalRevision).toBe(2);
      } finally { await afterExpiry.kill(); }
    } finally { await oldWorker.kill(); await oldRequest; }
  });

  it.each(['deletion-prepared', 'deletion-quarantined', 'deletion-committed', 'deletion-ack'] as const)('Phase E physical deletion recovers %s without losing confirmed evidence', async checkpoint => {
    const ctx = await source('Phase E ' + checkpoint);
    expect((await ctx.extract()).status).toBe(201);
    await request(app.getHttpServer()).post('/api/document-extraction/confirm').set(authHeader(ctx.user.accessToken))
      .send({ documentId: ctx.documentId, activities: [{ activityType: 'DIESEL', quantity: 1, unit: 'L', recordDate: '2026-03-07', jurisdictionCountry: 'Canada', sourceRow: 2 }] }).expect(201);
    const before = await work.activityData.findFirstOrThrow({ where: { organizationId: ctx.org.id } });
    expect(before.calculationSnapshot).not.toBeNull();
    const document = await work.document.findUniqueOrThrow({ where: { id: ctx.documentId } });
    const proxy = checkpoint === 'deletion-ack' ? await postgresAckProxy() : undefined;
    const url = new URL(process.env.DATABASE_URL!); if (proxy) url.port = String(proxy.port);
    const child = await controlProcess(checkpoint, { DATABASE_URL: url.toString() });
    const pending = child.request(`documents/${ctx.documentId}`, ctx.user.accessToken, undefined, 'DELETE');
    try {
      await child.wait(checkpoint === 'deletion-ack' ? 'deletion-prepared' : checkpoint);
      if (proxy) { proxy.arm(); child.child.send('release'); await proxy.lost; expect((await pending).status).not.toBe(200); }
      const intent = await work.documentDeletionIntent.findFirstOrThrow({ where: { documentId: ctx.documentId } });
      phaseEQuarantineKeys.push(intent.quarantineKey);
      const committed = checkpoint === 'deletion-committed' || checkpoint === 'deletion-ack';
      expect(intent.status).toBe(committed ? 'PENDING_PURGE' : 'PREPARED');
      const storage = app.get<DocumentStorage>(DOCUMENT_STORAGE);
      expect(await storage.exists(documentStorageKey(document.fileUrl))).toBe(checkpoint === 'deletion-prepared');
      expect(await storage.quarantineExists(intent.quarantineKey)).toBe(checkpoint !== 'deletion-prepared');
      expect(await work.document.count({ where: { id: ctx.documentId } })).toBe(committed ? 0 : 1);
      await child.kill(); await pending;
      const restarted = await controlProcess('normal');
      try {
        expect((await restarted.request(`documents/${ctx.documentId}`, ctx.user.accessToken, undefined, 'DELETE')).status).toBe(200);
        expect(await work.document.count({ where: { id: ctx.documentId } })).toBe(0);
        expect(await work.documentDeletionIntent.findUnique({ where: { id: intent.id } })).toMatchObject({ status: 'PENDING_PURGE' });
        expect(await storage.quarantineExists(intent.quarantineKey)).toBe(true);
        expect(await work.auditLog.count({ where: { entityId: intent.id, action: 'DELETE_DOCUMENT' } })).toBe(1);
        const after = await work.activityData.findUniqueOrThrow({ where: { id: before.id } });
        const { documentId: _oldDocument, updatedAt: _oldTime, ...oldEvidence } = before;
        const { documentId: _newDocument, updatedAt: _newTime, ...newEvidence } = after;
        expect(after.documentId).toBeNull(); expect(newEvidence).toEqual(oldEvidence);
        expect(await work.documentExtraction.count({ where: { documentId: ctx.documentId } })).toBe(0);
      } finally { await restarted.kill(); }
    } finally { await child.kill(); await pending; await proxy?.close(); }
  });

  it.each(['withdraw', 'suspend'] as const)('Phase E two-process same-tenant control race serializes %s first', async firstKind => {
    const ctx = await source('Phase E concurrent ' + firstKind, true), unrelated = await customer('Phase E unrelated ' + firstKind);
    const unrelatedBefore = await work.organizationRealDataAuthorization.findUnique({ where: { organizationId: unrelated.org.id } });
    const unrelatedOrgBefore = await work.organization.findUnique({ where: { id: unrelated.org.id } });
    const unrelatedUserBefore = await work.user.findUnique({ where: { id: unrelated.user.user.id } });
    const first = await controlProcess('control-' + firstKind), second = await controlProcess('normal');
    const withdrawRoute = `admin/organizations/${ctx.org.id}/real-data-authorization/withdraw`;
    const suspendRoute = 'admin/customer-provisioning/suspend', suspendBody = { ...ctx.target, confirmSuspend: true, suspensionReason: 'SYNTHETIC_PHASE_E' };
    const firstRequest = first.request(firstKind === 'withdraw' ? withdrawRoute : suspendRoute, admin.accessToken, firstKind === 'withdraw' ? ctx.withdrawal : suspendBody);
    try {
      await first.wait('control-fence-held');
      const rejected = await second.request(firstKind === 'withdraw' ? suspendRoute : withdrawRoute, admin.accessToken, firstKind === 'withdraw' ? suspendBody : ctx.withdrawal);
      expect(rejected.status).toBe(503); expect(rejected.body).toMatchObject({ code: 'CONTROL_FENCE_BUSY', outcome: 'NOT_COMMITTED', automaticRetry: false });
      first.child.send('release'); expect((await firstRequest).status).toBe(201);
      expect((await second.request(firstKind === 'withdraw' ? suspendRoute : withdrawRoute, admin.accessToken, firstKind === 'withdraw' ? suspendBody : ctx.withdrawal)).status).toBe(201);
      expect(await work.organization.findUnique({ where: { id: ctx.org.id } })).toMatchObject({ customerStatus: 'SUSPENDED' });
      expect(await work.organizationRealDataAuthorization.findUnique({ where: { organizationId: ctx.org.id } })).toMatchObject({ status: 'WITHDRAWN' });
      expect(await work.organizationAiAuthorization.findUnique({ where: { organizationId: ctx.org.id } })).toMatchObject({ status: 'WITHDRAWN' });
      expect(await work.auditLog.count({ where: { organizationId: ctx.org.id, action: 'REAL_DATA_AUTHORIZATION_WITHDRAWN' } })).toBe(1);
      expect(await work.auditLog.count({ where: { organizationId: ctx.org.id, action: 'CUSTOMER_ORGANIZATION_SUSPENDED' } })).toBe(1);
      expect(await work.realDataAuthorizationEvidence.count({ where: { authorizationDecisionId: { in: (await work.organizationRealDataAuthorization.findMany({ where: { organizationId: ctx.org.id } })).map(row => row.decisionId) } } })).toBe(2);
      expect(await work.organizationRealDataAuthorization.findUnique({ where: { organizationId: unrelated.org.id } })).toEqual(unrelatedBefore);
      expect(await work.organization.findUnique({ where: { id: unrelated.org.id } })).toEqual(unrelatedOrgBefore);
      expect(await work.user.findUnique({ where: { id: unrelated.user.user.id } })).toEqual(unrelatedUserBefore);
    } finally { first.child.send('release'); await first.kill(); await second.kill(); await firstRequest; }
  });

  async function syntheticSuspensionSource(history: 'absent' | 'withdrawn') {
    const ctx = await customer('Lifecycle suspension ' + history, false);
    if (history === 'withdrawn') { await ctx.approve(); expect((await ctx.withdraw()).status).toBe(201); }
    const upload = await request(app.getHttpServer()).post('/api/documents/upload').set(authHeader(ctx.user.accessToken))
      .set('X-CarbonLite-Data-Mode', 'SYNTHETIC_TEST').field('type', 'SPREADSHEET')
      .attach('file', Buffer.from(JSON.stringify([{ activityType: 'DIESEL', quantity: 1, unit: 'L', recordDate: '2026-03-07', jurisdictionCountry: 'Canada' }])),
        { filename: `${uniqueTestId(run)}.json`, contentType: 'application/json' }).expect(201);
    return { ...ctx, documentId: upload.body.id, suspension: { ...ctx.target, confirmSuspend: true, suspensionReason: 'SYNTHETIC_LIFECYCLE' } };
  }
  const suspensionCases = (['absent', 'withdrawn'] as const).flatMap(history =>
    (['suspension-before-fence', 'suspension-after-fence'] as const).map(checkpoint => ({ history, checkpoint })));
  it.each(suspensionCases)('Lifecycle suspension serializes $history authorization at $checkpoint', async ({ history, checkpoint }) => {
    const ctx = await syntheticSuspensionSource(history), before = await state(ctx.org.id);
    const extraction = await controlProcess(checkpoint), suspension = await controlProcess('normal');
    const pending = extraction.request('document-extraction/extract', ctx.user.accessToken, { documentId: ctx.documentId });
    const route = 'admin/customer-provisioning/suspend';
    try {
      await extraction.wait(checkpoint);
      const result = await suspension.request(route, admin.accessToken, ctx.suspension);
      if (checkpoint === 'suspension-after-fence') {
        expect(result.status).toBe(503);
        expect(result.body).toMatchObject({ code: 'CONTROL_FENCE_BUSY', outcome: 'NOT_COMMITTED', automaticRetry: false });
        expect((await work.organization.findUniqueOrThrow({ where: { id: ctx.org.id } })).customerStatus).toBe('ACTIVE');
        expect(await work.auditLog.count({ where: { organizationId: ctx.org.id, action: 'CUSTOMER_ORGANIZATION_SUSPENDED' } })).toBe(0);
        extraction.child.send('release'); expect((await pending).status).toBe(201);
        expect(await work.documentExtraction.count({ where: { documentId: ctx.documentId } })).toBe(1);
        expect((await suspension.request(route, admin.accessToken, ctx.suspension)).status).toBe(201);
      } else {
        expect(result.status).toBe(201);
        extraction.child.send('release'); expect((await pending).status).toBe(403);
        await noProtectedCommit(ctx.documentId);
        expect(await work.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_DOCUMENT' } })).toBe(0);
        expect(await work.userActivityEvent.count({ where: { entityId: ctx.documentId, eventName: 'DOCUMENT_EXTRACT_SUCCEEDED' } })).toBe(0);
        expect(await work.aIJob.findFirst({ where: { documentId: ctx.documentId } })).toMatchObject({ status: 'FAILED', leaseExpiresAt: null });
      }
      expect((await work.organization.findUniqueOrThrow({ where: { id: ctx.org.id } })).customerStatus).toBe('SUSPENDED');
      expect(await work.auditLog.count({ where: { organizationId: ctx.org.id, action: 'CUSTOMER_ORGANIZATION_SUSPENDED' } })).toBe(1);
      expect((await state(ctx.org.id)).authorization).toEqual(before.authorization);
      expect((await state(ctx.org.id)).evidence).toEqual(before.evidence);
      expect(await work.organizationAiAuthorization.count({ where: { organizationId: ctx.org.id } })).toBe(0);
    } finally { extraction.child.send('release'); await extraction.kill(); await suspension.kill(); await pending; }
  });
  it.each(['absent', 'withdrawn'] as const)('Lifecycle suspension audit rollback preserves %s authorization and organization', async history => {
    const ctx = await syntheticSuspensionSource(history), before = await state(ctx.org.id);
    const child = await controlProcess('suspension-audit-failure');
    try {
      expect((await child.request('admin/customer-provisioning/suspend', admin.accessToken, ctx.suspension)).status).toBe(500);
      expect(await state(ctx.org.id)).toEqual(before);
      expect((await work.organization.findUniqueOrThrow({ where: { id: ctx.org.id } })).customerStatus).toBe('ACTIVE');
      expect(await work.auditLog.count({ where: { organizationId: ctx.org.id, action: 'CUSTOMER_ORGANIZATION_SUSPENDED' } })).toBe(0);
      expect((await ctx.suspend()).status).toBe(201);
      expect(await work.auditLog.count({ where: { organizationId: ctx.org.id, action: 'CUSTOMER_ORGANIZATION_SUSPENDED' } })).toBe(1);
    } finally { await child.kill(); }
  });

  it('Phase E forced termination during shutdown rolls back the pending withdrawal and reconciles', async () => {
    const ctx = await customer('Phase E forced shutdown'), before = await state(ctx.org.id), child = await controlProcess('shutdown');
    const pending = child.request(`admin/organizations/${ctx.org.id}/real-data-authorization/withdraw`, admin.accessToken, ctx.withdrawal);
    try {
      await child.wait('withdrawal-prepared'); child.child.kill('SIGTERM'); await child.wait('draining'); await child.kill();
      expect((await pending).status).toBe(0); expect(await state(ctx.org.id)).toEqual(before);
      const restart = await controlProcess('normal');
      try { expect((await restart.request(`admin/organizations/${ctx.org.id}/real-data-authorization/withdraw`, admin.accessToken, ctx.withdrawal)).status).toBe(201); }
      finally { await restart.kill(); }
      expect((await state(ctx.org.id)).authorization?.status).toBe('WITHDRAWN');
      expect(await work.auditLog.count({ where: { organizationId: ctx.org.id, action: 'REAL_DATA_AUTHORIZATION_WITHDRAWN' } })).toBe(1);
    } finally { await child.kill(); await pending; }
  });

  it('Phase E two-process saturated Work and Control pools recover to authenticated mutations', async () => {
    const ctx = await customer('Phase E application saturation'), a = await controlProcess('normal'), b = await controlProcess('normal');
    try {
      a.child.send('hold-pools'); b.child.send('hold-pools');
      for (let index = 0; index < 6; index++) { await a.wait('connection-held'); await b.wait('connection-held'); }
      for (const worker of [a, b]) {
        const result = await worker.request(`admin/organizations/${ctx.org.id}/real-data-authorization/withdraw`, admin.accessToken, ctx.withdrawal);
        expect(result.status).toBe(503); expect(result.body.code).toBe('CONTROL_CAPACITY_UNAVAILABLE');
      }
      expect((await state(ctx.org.id)).authorization?.status).toBe('REAL_DATA_APPROVED');
      a.child.send('release'); b.child.send('release'); await a.wait('pools-released'); await b.wait('pools-released');
      expect((await a.request(`admin/organizations/${ctx.org.id}/real-data-authorization/withdraw`, admin.accessToken, ctx.withdrawal)).status).toBe(201);
      expect((await b.request(`admin/organizations/${ctx.org.id}/real-data-authorization/withdraw`, admin.accessToken, ctx.withdrawal)).body.result).toBe('ALREADY_WITHDRAWN');
      expect(await work.auditLog.count({ where: { organizationId: ctx.org.id, action: 'REAL_DATA_AUTHORIZATION_WITHDRAWN' } })).toBe(1);
    } finally { a.child.send('release'); b.child.send('release'); await a.kill(); await b.kill(); }
  });

  it('Phase E repeated upstream deadlines and connection interruption recover without queued mutations', async () => {
    const pooler = process.env.CONTROL_POOL_PGBOUNCER_TEST_URL; if (!pooler) throw new Error('Disposable pooler required'); assertSafeTestDatabaseTarget(pooler);
    const proxy = await postgresAckProxy({ upstreamPort: 55448 }), url = new URL(pooler); url.port = String(proxy.port);
    const one = await customer('Phase E upstream one'), two = await customer('Phase E upstream two');
    const a = await controlProcess('normal', { DATABASE_URL: url.toString() }), b = await controlProcess('normal', { DATABASE_URL: url.toString() });
    const holder = new PrismaClient(prototypePoolOptions('work', { ...process.env, DATABASE_URL: pooler }));
    const route = (id: string) => `admin/organizations/${id}/real-data-authorization/withdraw`;
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        const entered = [barrier(), barrier()], release = barrier();
        const holds = entered.map(gate => holder.$transaction(async tx => { await tx.$queryRaw`SELECT 1`; gate.resolve(); await release.promise; }, { timeout: 15000 }));
        await Promise.all(entered.map(gate => gate.promise));
        try {
          const results = await Promise.all([a.request(route(one.org.id), admin.accessToken, one.withdrawal), b.request(route(two.org.id), admin.accessToken, two.withdrawal)]);
          for (const result of results) { expect(result.status).toBe(503); expect(result.body).toMatchObject({ code: 'CONTROL_OUTCOME_UNCERTAIN', outcome: 'UNKNOWN', automaticRetry: false }); }
          expect((await a.request(route(one.org.id), admin.accessToken, one.withdrawal)).body.code).toBe('CONTROL_ADMISSION_BUSY');
          expect((await b.request(route(two.org.id), admin.accessToken, two.withdrawal)).body.code).toBe('CONTROL_ADMISSION_BUSY');
          expect((await state(one.org.id)).authorization?.status).toBe('REAL_DATA_APPROVED'); expect((await state(two.org.id)).authorization?.status).toBe('REAL_DATA_APPROVED');
          if (cycle === 0) proxy.interrupt();
        } finally { release.resolve(); await Promise.allSettled(holds); }
        a.child.send('wait-idle'); b.child.send('wait-idle'); await a.wait('control-idle'); await b.wait('control-idle');
      }
      expect((await a.request(route(one.org.id), admin.accessToken, one.withdrawal)).status).toBe(201);
      expect((await b.request(route(two.org.id), admin.accessToken, two.withdrawal)).status).toBe(201);
      for (const ctx of [one, two]) expect(await work.auditLog.count({ where: { organizationId: ctx.org.id, action: 'REAL_DATA_AUTHORIZATION_WITHDRAWN' } })).toBe(1);
    } finally { await a.kill(); await b.kill(); await holder.$disconnect(); await proxy.close(); }
  });

  it('Phase E observer-confirmed rollback differs from a lost COMMIT acknowledgement', async () => {
    const ctx = await source('Phase E commit not transmitted'), proxy = await postgresAckProxy({ beforeCommit: true });
    const url = new URL(process.env.DATABASE_URL!); url.port = String(proxy.port);
    const child = await controlProcess('final-ack', { DATABASE_URL: url.toString() });
    const pending = child.request('document-extraction/extract', ctx.user.accessToken, { documentId: ctx.documentId });
    try {
      await child.wait('final-ack'); proxy.arm(); child.child.send('release'); await proxy.lost;
      const response = await pending; expect(response.status).toBe(503); expect(response.body.outcome).toBe('UNKNOWN');
      await child.kill(); await noProtectedCommit(ctx.documentId);
      expect(await work.userActivityEvent.count({ where: { entityId: ctx.documentId, eventName: 'DOCUMENT_EXTRACT_SUCCEEDED' } })).toBe(0);
      const old = await work.aIJob.findFirstOrThrow({ where: { documentId: ctx.documentId } }); expect(old.status).toBe('RUNNING');
      const restart = await controlProcess('normal');
      try {
        expect((await restart.request('document-extraction/extract', ctx.user.accessToken, { documentId: ctx.documentId })).status).toBe(409);
        await work.aIJob.update({ where: { id: old.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
        expect((await restart.request('document-extraction/extract', ctx.user.accessToken, { documentId: ctx.documentId })).status).toBe(201);
        await committedExtraction(ctx.documentId); expect(restart.events.some(event => event.event === 'provider-accepted')).toBe(false);
      } finally { await restart.kill(); }
    } finally { await child.kill(); await pending; await proxy.close(); }
  });

  async function phaseEApplicationCounts() {
    return Promise.all([work.user.count(), work.organization.count(), work.membership.count(), work.document.count(),
      work.activityData.count(), work.auditLog.count(), work.userActivityEvent.count(), work.aIJob.count(),
      work.organizationRealDataAuthorization.count(), work.organizationAiAuthorization.count(), work.realDataAuthorizationEvidence.count()]);
  }

  it.each(['work', 'control'] as const)('Phase E actual SQL identity failure in %s prevents startup writes and closes constructed clients', async failingPool => {
    const countsBefore = await phaseEApplicationCounts();
    const verify = identityVerifier.verifyPoolIdentity; let calls = 0; const disconnects: jest.SpyInstance[] = [];
    const workInit = PrismaService.prototype.initializeVerified, controlInit = ControlDatabaseService.prototype.initializeVerified;
    jest.spyOn(PrismaService.prototype, 'initializeVerified').mockImplementation(function (this: PrismaService) {
      disconnects.push(jest.spyOn(this, '$disconnect')); return workInit.call(this);
    });
    jest.spyOn(ControlDatabaseService.prototype, 'initializeVerified').mockImplementation(function (this: ControlDatabaseService) {
      disconnects.push(jest.spyOn((this as unknown as { client: PrismaClient }).client, '$disconnect')); return controlInit.call(this);
    });
    jest.spyOn(identityVerifier, 'verifyPoolIdentity').mockImplementation(async (client, config) => {
      ++calls; return verify(client, calls === (failingPool === 'work' ? 1 : 2) ? { ...config, role: 'synthetic_wrong_role' } : config);
    });
    const marker = 'PHASE_E_STARTUP_WRITE_' + failingPool;
    const sentinel = { onModuleInit: () => work.userActivityEvent.create({ data: { organizationId: admin.user.organizationId, userId: admin.user.id, eventName: marker } }) };
    await expect(Test.createTestingModule({ imports: [AppModule], providers: [{ provide: 'PHASE_E_SENTINEL', useValue: sentinel }] }).compile()).rejects.toThrow();
    expect(await work.userActivityEvent.count({ where: { eventName: marker } })).toBe(0);
    expect(await phaseEApplicationCounts()).toEqual(countsBefore);
    expect(disconnects).toHaveLength(failingPool === 'work' ? 1 : 2);
    for (const spy of disconnects) expect(spy).toHaveBeenCalled();
  });

  it('Phase E startup hooks cannot write until both actual identity checks finish', async () => {
    const verify = identityVerifier.verifyPoolIdentity, entered = barrier(), release = barrier(); let calls = 0;
    jest.spyOn(identityVerifier, 'verifyPoolIdentity').mockImplementation(async (client, config) => {
      await verify(client, config); if (++calls === 2) { entered.resolve(); await release.promise; }
    });
    const marker = 'PHASE_E_STARTUP_ALLOWED';
    const sentinel = { onModuleInit: () => work.userActivityEvent.create({ data: { organizationId: admin.user.organizationId, userId: admin.user.id, eventName: marker } }) };
    const pending = Test.createTestingModule({ imports: [AppModule], providers: [{ provide: 'PHASE_E_SENTINEL', useValue: sentinel }] }).compile();
    await entered.promise;
    try { expect(await work.userActivityEvent.count({ where: { eventName: marker } })).toBe(0); }
    finally { release.resolve(); }
    const module = await pending, candidate = module.createNestApplication();
    try { await candidate.init(); expect(await work.userActivityEvent.count({ where: { eventName: marker } })).toBe(1); }
    finally { await candidate.close(); }
  });

  it('Phase E isolated prior-build rollback preserves durable withdrawal and evidence history', async () => {
    const root = process.env.CARBONLITE_PHASE_E_ROLLBACK_ARTIFACT; if (!root) throw new Error('Verified local prior-build artifact required');
    expect((await readFile(join(root, 'artifact-sha'), 'utf8')).trim()).toBe('0498646f5721619f91ee710a89386b4b84aaf329');
    const ctx = await customer('Phase E prior build'); expect((await ctx.withdraw()).status).toBe(201);
    const before = await state(ctx.org.id), countsBefore = await phaseEApplicationCounts();
    const old = await controlProcess('rollback', { CARBONLITE_TEST_BUILD_ROOT: root });
    try {
      const response = await old.request(`admin/organizations/${ctx.org.id}/real-data-authorization`, admin.accessToken, undefined, 'GET');
      expect(response.status).toBe(200); expect(response.body.status).toBe('WITHDRAWN');
      expect(await state(ctx.org.id)).toEqual(before); expect(await phaseEApplicationCounts()).toEqual(countsBefore);
    } finally { await old.kill(); }
    const current = await controlProcess('normal');
    try { expect(await state(ctx.org.id)).toEqual(before); expect(current.events.some(event => event.event === 'provider-accepted')).toBe(false); }
    finally { await current.kill(); }
  });

  const aiGrantDecision = { status: 'ENABLED', consentVersion: 'real-data-ai-v1', provider: 'OPENAI', processingScope: 'DOCUMENT_EXTRACTION',
    authorizedDataMode: 'REAL_CUSTOMER_DATA', realDataApprovalRevision: 1, evidenceReference: 'synthetic://generation',
    authorizedRepresentativeReference: 'synthetic-generation-operator', effectiveAt: '2026-11-01T00:00:00.000Z' };
  const grantEndpoint = (id: string) => `/api/admin/organizations/${id}/ai-authorization`;
  async function replaceAiGrant(id: string) {
    await request(app.getHttpServer()).post(`${grantEndpoint(id)}/withdraw`).set(authHeader(admin.accessToken))
      .send({ withdrawalReference: 'synthetic://generation-withdrawal' }).expect(201);
    return request(app.getHttpServer()).put(grantEndpoint(id)).set(authHeader(admin.accessToken)).send(aiGrantDecision).expect(200);
  }
  it('Grant generation starts at one and binds version-two durable admission', async () => {
    const ctx = await source('generation admission', true);
    const authorization = await work.organizationAiAuthorization.findUniqueOrThrow({ where: { organizationId: ctx.org.id } });
    expect(authorization).toMatchObject({ grantGeneration: 1 });
    const admitted = await app.get(ExtractionOperationsService).admit(ctx.org.id, ctx.documentId, ctx.user.user.id); admitted.release();
    const job = await work.aIJob.findUniqueOrThrow({ where: { id: admitted.operation.id } });
    expect(job.inputJson).toMatchObject({ version: 2, aiGrantGeneration: 1 });
  });
  it('Grant generation withdrawal and identical-consent replacement cannot revive old dispatch', async () => {
    const ctx = await source('generation old dispatch', true), operations = app.get(ExtractionOperationsService);
    const admitted = await operations.admit(ctx.org.id, ctx.documentId, ctx.user.user.id); admitted.release();
    const replacement = await replaceAiGrant(ctx.org.id);
    expect(replacement.body).toMatchObject({ grantGeneration: 2, consentVersion: aiGrantDecision.consentVersion });
    await expect(work.$transaction(tx => operations.dispatch(tx, ctx.org.id, ctx.documentId, admitted.operation.id, ctx.user.user.id))).rejects.toMatchObject({ status: 403 });
    expect(await work.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_PROVIDER_DISPATCH_ADMITTED' } })).toBe(0);
  });
  it('Grant generation replacement rejects old finalization and rolls back protected writes', async () => {
    const ctx = await source('generation old final', true), operations = app.get(ExtractionOperationsService);
    const admitted = await operations.admit(ctx.org.id, ctx.documentId, ctx.user.user.id); admitted.release();
    await work.$transaction(tx => operations.dispatch(tx, ctx.org.id, ctx.documentId, admitted.operation.id, ctx.user.user.id));
    await replaceAiGrant(ctx.org.id);
    await expect(work.$transaction(tx => operations.finalize(tx, ctx.org.id, ctx.documentId, admitted.operation.id,
      client => client.userActivityEvent.create({ data: { organizationId: ctx.org.id, entityId: ctx.documentId, eventName: 'GENERATION_UNSAFE' } })))).rejects.toMatchObject({ status: 403 });
    expect(await work.userActivityEvent.count({ where: { entityId: ctx.documentId, eventName: 'GENERATION_UNSAFE' } })).toBe(0);
    await noProtectedCommit(ctx.documentId);
  });
  it('Grant generation replacement cannot authorize missing generation metadata', async () => {
    const ctx = await source('generation missing', true), operations = app.get(ExtractionOperationsService);
    const admitted = await operations.admit(ctx.org.id, ctx.documentId, ctx.user.user.id); admitted.release();
    const job = await work.aIJob.findUniqueOrThrow({ where: { id: admitted.operation.id } });
    const metadata = { ...(job.inputJson as Prisma.JsonObject) }; delete metadata.aiGrantGeneration;
    await work.aIJob.update({ where: { id: job.id }, data: { inputJson: metadata } });
    await expect(work.$transaction(tx => operations.dispatch(tx, ctx.org.id, ctx.documentId, job.id))).rejects.toMatchObject({ status: 403 });
  });

  it('Grant generation B processes while completed A results remain unchanged across repeated cycles', async () => {
    const ctx = await source('generation cycles', true);
    provider.mockResolvedValue({ output_text: JSON.stringify({ activities: [{ activityType: 'DIESEL', quantity: 1, unit: 'L', recordDate: '2026-03-07', jurisdictionCountry: 'Canada' }] }) });
    expect((await ctx.extract()).status).toBe(201);
    const firstCompletion = await work.aIJob.findFirstOrThrow({ where: { documentId: ctx.documentId } });
    // Model a pre-upgrade completed job using an actual successful extraction.
    // Its archived identity is never accepted for new processing or rewritten.
    const legacyCompleted = { ...(firstCompletion.inputJson as Prisma.JsonObject), version: 1 }; delete (legacyCompleted as Prisma.JsonObject).aiGrantGeneration;
    await work.aIJob.update({ where: { id: firstCompletion.id }, data: { inputJson: legacyCompleted } });
    const completed = await work.aIJob.findUniqueOrThrow({ where: { id: firstCompletion.id } });
    const snapshot = await work.documentExtraction.findUnique({ where: { documentId: ctx.documentId } });
    expect(await work.$transaction(tx => app.get(ExtractionOperationsService).retireLegacy(tx, ctx.org.id, ctx.documentId, completed.id, admin.user.id))).toEqual({ retired: false });
    for (const generation of [2, 3, 4]) {
      expect((await replaceAiGrant(ctx.org.id)).body.grantGeneration).toBe(generation);
      expect(await work.aIJob.findUnique({ where: { id: completed.id } })).toEqual(completed);
      expect(await work.documentExtraction.findUnique({ where: { documentId: ctx.documentId } })).toEqual(snapshot);
    }
    expect((await ctx.extract()).status).toBe(201);
    const jobs = await work.aIJob.findMany({ where: { documentId: ctx.documentId }, orderBy: { createdAt: 'asc' } });
    expect(jobs).toHaveLength(2); expect(jobs[1].inputJson).toMatchObject({ version: 2, aiGrantGeneration: 4 });
    expect(jobs.every(job => job.status === 'COMPLETED' && job.leaseExpiresAt === null)).toBe(true);
  });
  it('Grant generation replacement during provider work rejects the old response without replay', async () => {
    const ctx = await source('generation provider wait', true), entered = barrier(), release = barrier();
    provider.mockImplementation(async () => { entered.resolve(); await release.promise; return { output_text: JSON.stringify({ activities: [] }) }; });
    const pending = ctx.extract(); await entered.promise;
    try { await replaceAiGrant(ctx.org.id); release.resolve(); expect((await pending).status).toBe(403); }
    finally { release.resolve(); await pending; }
    expect(provider).toHaveBeenCalledTimes(1); await noProtectedCommit(ctx.documentId);
    expect(await work.aIJob.findFirst({ where: { documentId: ctx.documentId } })).toMatchObject({ status: 'FAILED', leaseExpiresAt: null });
    expect(await work.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_DOCUMENT_FAILED' } })).toBe(1);
  });
  it.each([
    ['missing', undefined], ['null', null], ['zero', 0], ['negative', -1], ['text', '1'], ['fraction', 1.5], ['overflow', 2147483648],
  ])('Grant generation rejects malformed %s metadata', async (_label, generation) => {
    const ctx = await source('generation malformed ' + _label, true), operations = app.get(ExtractionOperationsService);
    const admitted = await operations.admit(ctx.org.id, ctx.documentId, ctx.user.user.id); admitted.release();
    const job = await work.aIJob.findUniqueOrThrow({ where: { id: admitted.operation.id } });
    const data = { ...(job.inputJson as Prisma.JsonObject), aiGrantGeneration: generation };
    if (generation === undefined) delete data.aiGrantGeneration;
    await work.aIJob.update({ where: { id: job.id }, data: { inputJson: data as Prisma.InputJsonObject } });
    await expect(work.$transaction(tx => operations.dispatch(tx, ctx.org.id, ctx.documentId, job.id))).rejects.toMatchObject({ status: 403 });
    expect(provider).not.toHaveBeenCalled(); await noProtectedCommit(ctx.documentId);
  });
  it.each(['organizationId', 'provider', 'processingScope'] as const)('Grant generation rejects cross-context %s identity', async field => {
    const ctx = await source('generation scope ' + field, true), other = await source('generation other ' + field, true), operations = app.get(ExtractionOperationsService);
    const admitted = await operations.admit(ctx.org.id, ctx.documentId, ctx.user.user.id); admitted.release();
    const job = await work.aIJob.findUniqueOrThrow({ where: { id: admitted.operation.id } });
    const changed = field === 'organizationId' ? other.org.id : field === 'provider' ? 'OTHER_PROVIDER' : 'OTHER_SCOPE';
    await work.aIJob.update({ where: { id: job.id }, data: { inputJson: { ...(job.inputJson as Prisma.JsonObject), [field]: changed } } });
    await expect(work.$transaction(tx => operations.dispatch(tx, ctx.org.id, ctx.documentId, job.id))).rejects.toMatchObject({ status: 403 });
    expect(provider).not.toHaveBeenCalled(); await noProtectedCommit(ctx.documentId);
  });
  it('Grant generation issuance and audit roll back together without consuming a generation', async () => {
    const ctx = await source('generation audit rollback', true), before = await work.organizationAiAuthorization.findUniqueOrThrow({ where: { organizationId: ctx.org.id } });
    const audit = app.get(AuditLogService), log = audit.log.bind(audit);
    const spy = jest.spyOn(audit, 'log').mockImplementation((input, tx) => {
      if (input.action === 'AI_AUTHORIZATION_RECORDED' && input.organizationId === ctx.org.id) throw new Error('Synthetic generation audit failure');
      return log(input, tx);
    });
    try { await expect(app.get(AiAuthorizationService).recordDecision(ctx.org.id, admin.user.id, aiGrantDecision as never)).rejects.toThrow('Synthetic generation audit failure'); }
    finally { spy.mockRestore(); }
    expect(await work.organizationAiAuthorization.findUnique({ where: { organizationId: ctx.org.id } })).toEqual(before);
    expect((await request(app.getHttpServer()).put(grantEndpoint(ctx.org.id)).set(authHeader(admin.accessToken)).send(aiGrantDecision).expect(200)).body.grantGeneration).toBe(2);
  });
  it('Grant generation concurrent issuance and withdrawal serialize without counter reuse', async () => {
    const ctx = await source('generation concurrent', true), service = app.get(AiAuthorizationService);
    const grants = await Promise.all([service.recordDecision(ctx.org.id, admin.user.id, aiGrantDecision as never), service.recordDecision(ctx.org.id, admin.user.id, aiGrantDecision as never)]);
    expect(grants.map(grant => grant.grantGeneration).sort()).toEqual([2, 3]);
    await Promise.all([service.withdraw(ctx.org.id, admin.user.id, 'synthetic://concurrent'), service.recordDecision(ctx.org.id, admin.user.id, aiGrantDecision as never)]);
    const final = await work.organizationAiAuthorization.findUniqueOrThrow({ where: { organizationId: ctx.org.id } });
    expect(final.grantGeneration).toBe(4); expect(['ENABLED', 'WITHDRAWN']).toContain(final.status);
    const audits = await work.auditLog.findMany({ where: { organizationId: ctx.org.id, action: 'AI_AUTHORIZATION_RECORDED' } });
    expect(audits.map(row => (row.newValue as Prisma.JsonObject).grantGeneration).sort()).toEqual([1, 2, 3, 4]);
  });
  it('Grant generation is server-owned, cannot reset through deletion, and fails closed on exhaustion', async () => {
    const ctx = await source('generation bounds', true), before = await work.organizationAiAuthorization.findUniqueOrThrow({ where: { organizationId: ctx.org.id } });
    await request(app.getHttpServer()).put(grantEndpoint(ctx.org.id)).set(authHeader(admin.accessToken)).send({ ...aiGrantDecision, grantGeneration: 1 }).expect(400);
    expect(await work.organizationAiAuthorization.findUnique({ where: { organizationId: ctx.org.id } })).toEqual(before);
    await expect(work.organizationAiAuthorization.delete({ where: { organizationId: ctx.org.id } })).rejects.toThrow();
    await expect(work.organizationAiAuthorization.update({ where: { organizationId: ctx.org.id }, data: { grantGeneration: 0 } })).rejects.toThrow();
    await expect(work.$executeRawUnsafe('TRUNCATE "OrganizationAiAuthorization"')).rejects.toThrow();
    await work.organizationAiAuthorization.update({ where: { organizationId: ctx.org.id }, data: { grantGeneration: 2147483647 } });
    const counts = await work.auditLog.count({ where: { organizationId: ctx.org.id } });
    await request(app.getHttpServer()).put(grantEndpoint(ctx.org.id)).set(authHeader(admin.accessToken)).send(aiGrantDecision).expect(409)
      .expect(({ body }) => expect(body.code).toBe('AI_GRANT_GENERATION_EXHAUSTED'));
    expect((await work.organizationAiAuthorization.findUniqueOrThrow({ where: { organizationId: ctx.org.id } })).grantGeneration).toBe(2147483647);
    expect(await work.auditLog.count({ where: { organizationId: ctx.org.id } })).toBe(counts);
  });
  it('Grant generation remains independent of real-data decisions and rejects expired leases', async () => {
    const ctx = await source('generation independent', true), operations = app.get(ExtractionOperationsService);
    const realBefore = await work.organizationRealDataAuthorization.findUniqueOrThrow({ where: { organizationId: ctx.org.id } });
    const admitted = await operations.admit(ctx.org.id, ctx.documentId, ctx.user.user.id); admitted.release();
    await replaceAiGrant(ctx.org.id);
    expect(await work.organizationRealDataAuthorization.findUnique({ where: { organizationId: ctx.org.id } })).toEqual(realBefore);
    await work.aIJob.update({ where: { id: admitted.operation.id }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });
    await expect(work.$transaction(tx => operations.dispatch(tx, ctx.org.id, ctx.documentId, admitted.operation.id))).rejects.toMatchObject({ status: 409 });
    expect((await ctx.withdraw()).status).toBe(201); const realAfter = await ctx.approve();
    expect(realAfter.approvalRevision).toBe(realBefore.approvalRevision + 1);
    expect((await work.organizationAiAuthorization.findUniqueOrThrow({ where: { organizationId: ctx.org.id } })).grantGeneration).toBe(2);
    expect((await work.organizationAiAuthorization.findUniqueOrThrow({ where: { organizationId: ctx.org.id } })).status).toBe('WITHDRAWN');
    const newGrant = await request(app.getHttpServer()).put(grantEndpoint(ctx.org.id)).set(authHeader(admin.accessToken)).send({ ...aiGrantDecision, realDataApprovalRevision: realAfter.approvalRevision }).expect(200);
    expect(newGrant.body).toMatchObject({ grantGeneration: 3, realDataApprovalRevision: 2 });
  });
  it.each(['PENDING', 'RUNNING'] as const)('Grant generation legacy %s jobs require explicit audited retirement before retry', async legacyStatus => {
    const ctx = await source('generation legacy operation', true), operations = app.get(ExtractionOperationsService);
    const admitted = await operations.admit(ctx.org.id, ctx.documentId, ctx.user.user.id); admitted.release();
    const job = await work.aIJob.findUniqueOrThrow({ where: { id: admitted.operation.id } });
    const legacy = { ...(job.inputJson as Prisma.JsonObject), version: 1 }; delete (legacy as Prisma.JsonObject).aiGrantGeneration;
    await work.aIJob.update({ where: { id: job.id }, data: { inputJson: legacy, status: legacyStatus } });
    await expect(work.$transaction(tx => operations.dispatch(tx, ctx.org.id, ctx.documentId, job.id))).rejects.toMatchObject({ status: 403 });
    await expect(work.$transaction(tx => operations.retireLegacy(tx, ctx.org.id, ctx.documentId, job.id, admin.user.id))).rejects.toMatchObject({ status: 409 });
    await work.aIJob.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });
    const denied = await ctx.extract(); expect(denied.status).toBe(409); expect(denied.body.code).toBe('EXTRACTION_LEGACY_RECONCILIATION_REQUIRED');
    expect((await work.aIJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(legacyStatus);
    const audit = app.get(AuditLogService), log = audit.log.bind(audit);
    const spy = jest.spyOn(audit, 'log').mockImplementation((input, tx) => { if (input.action === 'EXTRACT_LEGACY_OPERATION_RETIRED') throw new Error('Synthetic retirement audit failure'); return log(input, tx); });
    try { await expect(work.$transaction(tx => operations.retireLegacy(tx, ctx.org.id, ctx.documentId, job.id, admin.user.id))).rejects.toThrow('Synthetic retirement audit failure'); }
    finally { spy.mockRestore(); }
    expect((await work.aIJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(legacyStatus);
    expect(await work.$transaction(tx => operations.retireLegacy(tx, ctx.org.id, ctx.documentId, job.id, admin.user.id))).toEqual({ retired: true });
    expect(await work.aIJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'FAILED', leaseExpiresAt: null, inputJson: legacy });
    expect(await work.auditLog.count({ where: { entityId: ctx.documentId, action: 'EXTRACT_LEGACY_OPERATION_RETIRED' } })).toBe(1);
    expect(await work.$transaction(tx => operations.retireLegacy(tx, ctx.org.id, ctx.documentId, job.id, admin.user.id))).toEqual({ retired: false });
    await noProtectedCommit(ctx.documentId); expect(provider).not.toHaveBeenCalled();
  });
  it('Grant generation zero is ineffective until explicit reissuance and local extraction has null generation', async () => {
    const ctx = await customer('generation zero');
    await work.organizationAiAuthorization.create({ data: { ...aiGrantDecision, organizationId: ctx.org.id, status: 'ENABLED', authorizedDataMode: 'REAL_CUSTOMER_DATA',
      verifiedById: admin.user.id, verifiedAt: new Date(), effectiveAt: new Date(aiGrantDecision.effectiveAt) } });
    await expect(app.get(AiAuthorizationService).assertProviderRequestAllowed(ctx.org.id, 'OPENAI', 'DOCUMENT_EXTRACTION', 'REAL_CUSTOMER_DATA')).rejects.toMatchObject({ status: 403 });
    expect((await request(app.getHttpServer()).put(grantEndpoint(ctx.org.id)).set(authHeader(admin.accessToken)).send(aiGrantDecision).expect(200)).body.grantGeneration).toBe(1);
    const local = await source('generation local'); expect((await local.extract()).status).toBe(201);
    expect((await work.aIJob.findFirstOrThrow({ where: { documentId: local.documentId } })).inputJson).toMatchObject({ version: 2, aiGrantGeneration: null });
  });

  it('Grant generation lost issuance acknowledgement returns UNKNOWN without another grant', async () => {
    const ctx = await source('generation uncertain issuance', true), proxy = await postgresAckProxy();
    const url = new URL(process.env.DATABASE_URL!); url.port = String(proxy.port);
    const child = await controlProcess('grant-ack', { DATABASE_URL: url.toString() });
    const pending = child.request(`admin/organizations/${ctx.org.id}/ai-authorization`, admin.accessToken, aiGrantDecision, 'PUT');
    try {
      await child.wait('grant-prepared'); proxy.arm(); child.child.send('release'); await proxy.lost;
      expect(await pending).toMatchObject({ status: 503, body: { code: 'AI_GRANT_OUTCOME_UNCERTAIN', outcome: 'UNKNOWN', automaticRetry: false, reconciliationRequired: true } });
      expect((await work.organizationAiAuthorization.findUniqueOrThrow({ where: { organizationId: ctx.org.id } })).grantGeneration).toBe(2);
      expect(await work.auditLog.count({ where: { organizationId: ctx.org.id, action: 'AI_AUTHORIZATION_RECORDED' } })).toBe(2);
    } finally { await child.kill(); await pending; await proxy.close(); }
  });
  it('Grant generation rollback reads with the actual old Prisma client but blocks all old writes', async () => {
    const ctx = await source('generation rollback gate', true);
    provider.mockResolvedValue({ output_text: JSON.stringify({ activities: [{ activityType: 'DIESEL', quantity: 1, unit: 'L', recordDate: '2026-03-07', jurisdictionCountry: 'Canada' }] }) });
    expect((await ctx.extract()).status).toBe(201);
    const completedBefore = await work.aIJob.findFirstOrThrow({ where: { documentId: ctx.documentId } });
    const resultBefore = await work.documentExtraction.findUniqueOrThrow({ where: { documentId: ctx.documentId } });
    await replaceAiGrant(ctx.org.id);
    const before = await work.organizationAiAuthorization.findUniqueOrThrow({ where: { organizationId: ctx.org.id } });
    const countsBefore = await phaseEApplicationCounts();
    const old = await controlProcess('rollback', { CARBONLITE_TEST_BUILD_ROOT: process.env.CARBONLITE_PHASE_E_ROLLBACK_ARTIFACT! });
    try {
      const read = await old.request(`admin/organizations/${ctx.org.id}/ai-authorization`, admin.accessToken, undefined, 'GET');
      expect(read.status).toBe(200); expect(read.body).not.toHaveProperty('grantGeneration');
      expect((await old.request(`admin/organizations/${ctx.org.id}/ai-authorization`, admin.accessToken, aiGrantDecision, 'PUT')).body.code).toBe('ROLLBACK_READ_ONLY_REQUIRED');
      expect((await old.request('document-extraction/extract', ctx.user.accessToken, { documentId: ctx.documentId })).body.code).toBe('ROLLBACK_READ_ONLY_REQUIRED');
      expect(await work.organizationAiAuthorization.findUnique({ where: { organizationId: ctx.org.id } })).toEqual(before);
      expect(await phaseEApplicationCounts()).toEqual(countsBefore);
      expect(old.events.some(event => event.event === 'provider-accepted')).toBe(false);
      expect(await work.aIJob.findUnique({ where: { id: completedBefore.id } })).toEqual(completedBefore);
      expect(await work.documentExtraction.findUnique({ where: { documentId: ctx.documentId } })).toEqual(resultBefore);
    } finally { await old.kill(); }
  });
  it('Grant generation migration preserves existing fields and assigns only unknown zero', async () => {
    const migration = await readFile(join(process.cwd(), 'prisma/migrations/20261119000000_ai_grant_generation/migration.sql'), 'utf8');
    const ddl = migration.replace(/^BEGIN;\n/, '').replace(/\nCOMMIT;\n?$/, '');
    const sql = `BEGIN; CREATE SCHEMA grant_migration_fixture; SET LOCAL search_path TO grant_migration_fixture;
      CREATE TABLE "Organization" ("id" text PRIMARY KEY);
      CREATE TABLE "OrganizationAiAuthorization" ("organizationId" text PRIMARY KEY REFERENCES "Organization"("id") ON DELETE CASCADE, "status" text NOT NULL, "consentVersion" text NOT NULL);
      INSERT INTO "Organization" VALUES ('synthetic-a'), ('synthetic-b');
      INSERT INTO "OrganizationAiAuthorization" VALUES ('synthetic-a', 'ENABLED', 'synthetic-v1'), ('synthetic-b', 'WITHDRAWN', 'synthetic-v1');
      ${ddl}
      SELECT json_build_object('rows', count(*), 'unknown', count(*) FILTER (WHERE "grantGeneration" = 0), 'consent', count(*) FILTER (WHERE "consentVersion" = 'synthetic-v1')) FROM "OrganizationAiAuthorization";
      ROLLBACK;`;
    const output = await promisify(execFile)('docker', ['exec', '-i', process.env.CONTROL_POOL_TEST_POSTGRES_CONTAINER!, 'psql', '-U', 'postgres', '-d', 'carbonlite_ci_test', '-v', 'ON_ERROR_STOP=1', '-Atc', sql]);
    const row = output.stdout.split('\n').find(line => line.startsWith('{')); expect(JSON.parse(row!)).toEqual({ rows: 2, unknown: 2, consent: 2 });
  });

  it.each(['dispatch', 'finalize'] as const)('Grant generation withdrawal alone rejects admitted %s without success or completed lease', async stage => {
    const ctx = await source('generation withdrawn ' + stage, true), operations = app.get(ExtractionOperationsService);
    const admitted = await operations.admit(ctx.org.id, ctx.documentId, ctx.user.user.id); admitted.release();
    if (stage === 'finalize') await work.$transaction(tx => operations.dispatch(tx, ctx.org.id, ctx.documentId, admitted.operation.id));
    await request(app.getHttpServer()).post(`${grantEndpoint(ctx.org.id)}/withdraw`).set(authHeader(admin.accessToken)).send({ withdrawalReference: 'synthetic://before-' + stage }).expect(201);
    await expect(work.$transaction(tx => stage === 'dispatch' ? operations.dispatch(tx, ctx.org.id, ctx.documentId, admitted.operation.id) :
      operations.finalize(tx, ctx.org.id, ctx.documentId, admitted.operation.id, async () => undefined))).rejects.toMatchObject({ status: 403 });
    await noProtectedCommit(ctx.documentId); expect(provider).not.toHaveBeenCalled();
    expect((await work.aIJob.findUniqueOrThrow({ where: { id: admitted.operation.id } })).status).toBe('RUNNING');
    expect((await work.organizationAiAuthorization.findUniqueOrThrow({ where: { organizationId: ctx.org.id } })).grantGeneration).toBe(1);
  });

  it('Grant generation quota expiry preserves an unknown other-document operation for reconciliation', async () => {
    const ctx = await source('generation unknown expiry', true), operations = app.get(ExtractionOperationsService);
    const admitted = await operations.admit(ctx.org.id, ctx.documentId, ctx.user.user.id); admitted.release();
    const job = await work.aIJob.findUniqueOrThrow({ where: { id: admitted.operation.id } });
    const unknown = { ...(job.inputJson as Prisma.JsonObject) }; delete unknown.aiGrantGeneration;
    await work.aIJob.update({ where: { id: job.id }, data: { inputJson: unknown, leaseExpiresAt: new Date(Date.now() - 1) } });
    const other = await request(app.getHttpServer()).post('/api/documents/upload').set(authHeader(ctx.user.accessToken)).set('X-CarbonLite-Data-Mode', 'REAL_CUSTOMER_DATA')
      .field('type', 'PDF').field('allowDuplicate', 'true').attach('file', Buffer.from('%PDF-1.4\n% Synthetic unknown lease\n%%EOF\n'), { filename: `${uniqueTestId(run)}.pdf`, contentType: 'application/pdf' }).expect(201);
    provider.mockResolvedValue({ output_text: JSON.stringify({ activities: [] }) });
    await request(app.getHttpServer()).post('/api/document-extraction/extract').set(authHeader(ctx.user.accessToken)).send({ documentId: other.body.id }).expect(201);
    expect(await work.aIJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'RUNNING', inputJson: unknown });
    const denied = await ctx.extract(); expect(denied.status).toBe(409); expect(denied.body.code).toBe('EXTRACTION_LEGACY_RECONCILIATION_REQUIRED');
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('E2E fixture owns a stable ready listener through authorized and denied requests and shutdown', async () => {
    const fixture = await createE2eApp(), server = fixture.app.getHttpServer();
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a ready TCP listener');
      expect(server.listening).toBe(true); expect(address.address).toBe('127.0.0.1');
      await request(server).get('/api/auth/me').set(authHeader(admin.accessToken)).expect(200);
      await request(server).get('/api/auth/me').expect(401);
      await request(server).get('/api/auth/me').set(authHeader(admin.accessToken)).expect(200);
      expect(server.listening).toBe(true); const after = server.address();
      if (!after || typeof after === 'string') throw new Error('Expected the original TCP listener');
      expect(after.port).toBe(address.port);
    } finally { await fixture.app.close(); }
    expect(server.listening).toBe(false); expect(server.address()).toBeNull();
  });

  it('Grant generation migration failure rolls back the column and reset guards together', async () => {
    const migration = await readFile(join(process.cwd(), 'prisma/migrations/20261119000000_ai_grant_generation/migration.sql'), 'utf8');
    const cli = ['exec', process.env.CONTROL_POOL_TEST_POSTGRES_CONTAINER!, 'psql', '-U', 'postgres', '-d', 'carbonlite_ci_test', '-v', 'ON_ERROR_STOP=1', '-Atc'];
    const runSql = (sql: string) => promisify(execFile)('docker', [...cli, sql]);
    await runSql('CREATE SCHEMA grant_atomic_fixture; CREATE TABLE grant_atomic_fixture."OrganizationAiAuthorization" ("organizationId" text PRIMARY KEY);');
    try {
      await expect(runSql('SET search_path TO grant_atomic_fixture; ' + migration.replace('COMMIT;', 'SELECT 1/0; COMMIT;'))).rejects.toThrow();
      const result = await runSql("SELECT count(*) FROM information_schema.columns WHERE table_schema='grant_atomic_fixture' AND column_name='grantGeneration'; SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='grant_atomic_fixture' AND p.proname='carbonlite_guard_ai_grant_generation';");
      expect(result.stdout.trim().split('\n')).toEqual(['0', '0']);
    } finally { await runSql('DROP SCHEMA grant_atomic_fixture CASCADE;'); }
  });

});

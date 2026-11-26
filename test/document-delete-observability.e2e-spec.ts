import { ConflictException, INestApplication, Logger } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { DOCUMENT_STORAGE, DocumentStorage, documentStorageKey } from '../src/documents/document-storage';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { validRequestId } from '../src/common/monitoring/document-delete-diagnostics';
import { DocumentsService } from '../src/documents/documents.service';
import { LegalHoldsService } from '../src/legal-holds/legal-holds.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import { assertSafeTestDatabaseTarget } from './helpers/database-safety';
import { authHeader, cleanupTestData, createTestUser, TestUser, uniqueTestId } from './helpers/factories';

describe('Document delete observability (disposable PostgreSQL)', () => {
  let app: INestApplication; let prisma: PrismaService; let storage: DocumentStorage;
  let tenant: TestUser; let other: TestUser; let directory: string;
  const run = uniqueTestId('delete-observability');
  const originalStoragePath = process.env.DOCUMENT_STORAGE_PATH;
  const originalRegistration = process.env.PUBLIC_REGISTRATION_ENABLED;
  const spoof = '72676144-1328-4cd1-95f4-d677e7d55139';

  beforeAll(async () => {
    assertSafeTestDatabaseTarget();
    directory = await mkdtemp(join(tmpdir(), 'carbonlite-delete-observability-'));
    process.env.DOCUMENT_STORAGE_PATH = directory;
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
    const e2e = await createE2eApp({ globalFilters: [new GlobalExceptionFilter()], correlateRequests: true });
    app = e2e.app; prisma = e2e.prisma; storage = app.get(DOCUMENT_STORAGE);
    [tenant, other] = await Promise.all(['owner', 'other'].map(name => createTestUser(app, {
      organizationName: `${run}-${name}`, email: `${run}-${name}@example.test`, password: 'Synthetic-Only!2026',
    })));
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    jest.restoreAllMocks();
    if (prisma && tenant && other) {
      await prisma.documentDeletionIntent.deleteMany({ where: { organizationId: { in: [tenant.user.organizationId, other.user.organizationId] } } });
      await cleanupTestData(prisma, run);
    }
    if (app) await app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    if (originalStoragePath === undefined) delete process.env.DOCUMENT_STORAGE_PATH;
    else process.env.DOCUMENT_STORAGE_PATH = originalStoragePath;
    if (originalRegistration === undefined) delete process.env.PUBLIC_REGISTRATION_ENABLED;
    else process.env.PUBLIC_REGISTRATION_ENABLED = originalRegistration;
  });

  async function upload(name: string) {
    return (await request(app.getHttpServer()).post('/api/documents/upload').set(authHeader(tenant.accessToken))
      .field('type', 'SPREADSHEET').attach('file', Buffer.from(`activityType,recordDate,quantity,unit\nDIESEL,2026-01-01,1,L\n# ${name}\n`),
        { filename: `${run}-${name}.csv`, contentType: 'text/csv' }).expect(201)).body;
  }
  function remove(id: string, actor = tenant) {
    return request(app.getHttpServer()).delete(`/api/documents/${id}`).set(authHeader(actor.accessToken)).set('X-Request-ID', spoof);
  }
  function faultAudit(action: string) {
    const targetPrisma = action === 'DELETE_DOCUMENT' ? (app.get(LegalHoldsService) as any).prisma
      : (app.get(DocumentsService) as any).prisma;
    const original = targetPrisma.$transaction.bind(targetPrisma) as any;
    jest.spyOn(targetPrisma, '$transaction').mockImplementation(((work: any, options: any) => {
      if (typeof work !== 'function') return original(work, options);
      return original((tx: any) => work(new Proxy(tx, { get(target, key) {
        if (key !== 'auditLog') return target[key];
        return new Proxy(target.auditLog, { get(audit, method) {
          if (method !== 'create') return audit[method];
          return (args: any) => {
            if (args.data.action === action) throw new Error('private-exception-canary');
            return audit.create(args);
          };
        } });
      } })), options);
    }) as any);
  }

  it('preserves imported Activity Records, successful audit and idempotent deletion', async () => {
    const doc = await upload('success');
    const record = await prisma.activityData.create({ data: { organizationId: tenant.user.organizationId,
      documentId: doc.id, sourceDocumentId: doc.id, activityType: 'DIESEL', recordDate: new Date('2026-01-01'),
      quantity: 1, unit: 'L', sourceType: 'IMPORT', calculationSnapshot: { synthetic: true } } });
    const response = await remove(doc.id).expect(200);
    expect(validRequestId(response.headers['x-request-id'])).toBe(true);
    expect(response.headers['x-request-id']).not.toBe(spoof);
    expect(await prisma.activityData.findUnique({ where: { id: record.id } })).toMatchObject({
      documentId: null, sourceDocumentId: doc.id, calculationSnapshot: { synthetic: true } });
    expect((await remove(doc.id).expect(200)).body.idempotent).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'DELETE_DOCUMENT', entityId: response.body.deletionIntentId } })).toBe(1);
  });

  it('correlates missing bytes and preserves metadata; repeated failure never probes storage again', async () => {
    const doc = await upload('missing'); await storage.delete(documentStorageKey(doc.fileUrl));
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = await remove(doc.id).expect(503);
    expect(response.body).toMatchObject({ code: 'DOCUMENT_DELETE_RECONCILIATION_REQUIRED', requestId: response.headers['x-request-id'] });
    expect(validRequestId(response.body.requestId)).toBe(true); expect(response.body.requestId).not.toBe(spoof);
    const intent = await prisma.documentDeletionIntent.findFirstOrThrow({ where: { documentId: doc.id, organizationId: tenant.user.organizationId } });
    expect(intent).toMatchObject({ status: 'RECONCILIATION_REQUIRED', reconciliationCode: 'ACTIVE_AND_QUARANTINE_MISSING', databaseDeletedAt: null });
    expect(await prisma.document.findUnique({ where: { id: doc.id } })).not.toBeNull();
    expect(await prisma.auditLog.findFirst({ where: { organizationId: tenant.user.organizationId, action: 'DOCUMENT_DELETE_DIAGNOSTIC', entityId: intent.id } }))
      .toMatchObject({ newValue: expect.objectContaining({ requestId: response.body.requestId, documentId: doc.id }) });
    const log = JSON.stringify(logger.mock.calls);
    for (const forbidden of [doc.id, doc.fileUrl, doc.fileName, tenant.user.organizationId, tenant.user.email]) expect(log).not.toContain(forbidden);
    const quarantine = jest.spyOn(storage, 'quarantine');
    const repeated = await remove(doc.id).expect(503);
    expect(repeated.body.requestId).not.toBe(response.body.requestId);
    expect(quarantine).not.toHaveBeenCalled();
    expect(logger.mock.calls.some(([line]) => String(line).includes('EXISTING_RECONCILIATION_REQUIRED') && String(line).includes('"activeExists":null'))).toBe(true);
  });

  it('denies another tenant and unauthenticated callers before storage access or diagnostic audit linkage', async () => {
    const doc = await upload('private'); const quarantine = jest.spyOn(storage, 'quarantine');
    const response = await remove(doc.id, other).expect(403);
    expect(response.body.code).toBeUndefined(); expect(response.body).not.toHaveProperty('intentStatus');
    await request(app.getHttpServer()).delete(`/api/documents/${doc.id}`).expect(401);
    expect(quarantine).not.toHaveBeenCalled();
    expect(await prisma.auditLog.count({ where: { organizationId: other.user.organizationId, action: 'DOCUMENT_DELETE_DIAGNOSTIC' } })).toBe(0);
  });

  it('preserves legal-hold denial before any storage operation', async () => {
    const doc = await upload('hold'); const quarantine = jest.spyOn(storage, 'quarantine');
    jest.spyOn(app.get(LegalHoldsService), 'withDeletionGuard').mockRejectedValueOnce(new ConflictException({ code: 'LEGAL_HOLD_ACTIVE', message: 'Deletion is temporarily restricted.' }));
    expect((await remove(doc.id).expect(409)).body.code).toBe('LEGAL_HOLD_ACTIVE');
    expect(quarantine).not.toHaveBeenCalled();
  });

  it('keeps storage failures non-successful without logging exception text', async () => {
    const doc = await upload('storage-failure');
    jest.spyOn(storage, 'quarantine').mockRejectedValueOnce(new Error('private-storage-canary'));
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await remove(doc.id).expect(500);
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-storage-canary');
    expect(await prisma.document.findUnique({ where: { id: doc.id } })).not.toBeNull();
  });

  it('retains recoverable bytes and metadata after transactional audit rollback, then retries idempotently', async () => {
    const doc = await upload('rollback'); faultAudit('DELETE_DOCUMENT');
    await remove(doc.id).expect(500);
    const intent = await prisma.documentDeletionIntent.findFirstOrThrow({ where: { documentId: doc.id } });
    expect(intent.status).toBe('PREPARED'); expect(await storage.quarantineExists(intent.quarantineKey)).toBe(true);
    expect(await prisma.document.findUnique({ where: { id: doc.id } })).not.toBeNull();
    jest.restoreAllMocks(); expect((await remove(doc.id).expect(200)).body.storageLifecycle).toBe('PENDING_PURGE');
  });

  it('preserves the 503 and metadata when diagnostic emission itself throws', async () => {
    const doc = await upload('log-failure'); await storage.delete(documentStorageKey(doc.fileUrl));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => { throw new Error('private-logger-canary'); });
    const response = await remove(doc.id).expect(503);
    expect(response.body.code).toBe('DOCUMENT_DELETE_RECONCILIATION_REQUIRED');
    expect(await prisma.document.findUnique({ where: { id: doc.id } })).not.toBeNull();
  });

  it('does not turn correlation-audit failure into success or erase the original reconciliation error', async () => {
    const doc = await upload('diagnostic-failure'); await storage.delete(documentStorageKey(doc.fileUrl));
    faultAudit('DOCUMENT_DELETE_DIAGNOSTIC');
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    expect((await remove(doc.id).expect(503)).body.code).toBe('DOCUMENT_DELETE_RECONCILIATION_REQUIRED');
    expect(log.mock.calls.some(([line]) => String(line).includes('"correlationLinkAvailable":false'))).toBe(true);
    expect(await prisma.document.findUnique({ where: { id: doc.id } })).not.toBeNull();
  });
});

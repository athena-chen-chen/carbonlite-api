import { DeletionRecoveryService } from './deletion-recovery.service';
import { DocumentsService } from '../documents/documents.service';
import { attachDeleteFailure, deleteDiagnostic, emptyDeleteObservation } from '../common/monitoring/document-delete-diagnostics';

const reference = '72676144-1328-4cd1-95f4-d677e7d55139';
const scope = { organizationId: 'tenant-canary', documentId: 'document-canary', intentId: 'intent-canary' };

function fixture(status = 'PREPARED') {
  const intent = { id: scope.intentId, organizationId: scope.organizationId, documentId: scope.documentId,
    storageKey: 'secret-path', quarantineKey: '.quarantine/secret-path', status, reconciliationCode: null };
  const tx = {
    documentDeletionIntent: { findFirst: jest.fn().mockResolvedValue(intent),
      update: jest.fn().mockImplementation(async ({ data }) => ({ ...intent, ...data })) },
    document: { findUnique: jest.fn().mockResolvedValue({ id: scope.documentId, organizationId: scope.organizationId }), delete: jest.fn().mockResolvedValue({}) },
    activityData: { count: jest.fn().mockResolvedValue(3) },
    auditLog: { create: jest.fn().mockResolvedValue({}) }, userActivityEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const storage = { quarantine: jest.fn().mockResolvedValue({ result: 'MOVED', quarantineKey: intent.quarantineKey }) };
  const guard = { withDeletionGuard: jest.fn(async (_input, work) => work(tx)) };
  const service = new DeletionRecoveryService({} as any, storage as any, guard as any);
  return { intent, tx, storage, guard, service };
}

async function failure(f: ReturnType<typeof fixture>) {
  let error: unknown;
  try { await f.service.completeDocument(scope.organizationId, scope.documentId, undefined, reference); }
  catch (e) { error = e; }
  expect(error).toBeDefined();
  return { error, record: deleteDiagnostic(error, reference, 503) };
}

it('preserves successful deletion, Activity Record count, audit and idempotent completion', async () => {
  const f = fixture();
  expect(await f.service.completeDocument(scope.organizationId, scope.documentId)).toMatchObject({ idempotent: false, preservedActivityRecords: 3 });
  expect(f.tx.document.delete).toHaveBeenCalledTimes(1);
  expect(f.tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'DELETE_DOCUMENT' }) }));
  const done = fixture('PENDING_PURGE');
  expect(await done.service.completeDocument(scope.organizationId, scope.documentId)).toMatchObject({ idempotent: true });
  expect(done.storage.quarantine).not.toHaveBeenCalled();
});

it('retains the existing missing-bytes transition and records observed false/false', async () => {
  const f = fixture(); f.storage.quarantine.mockResolvedValue({ result: 'NOT_FOUND', quarantineKey: f.intent.quarantineKey });
  const { record } = await failure(f);
  expect(record).toMatchObject({ reason: 'ACTIVE_AND_QUARANTINE_MISSING', intentStatus: 'RECONCILIATION_REQUIRED',
    reconciliationCode: 'ACTIVE_AND_QUARANTINE_MISSING', activeExists: false, quarantineExists: false, evidenceAvailable: true });
  expect(f.tx.documentDeletionIntent.update).toHaveBeenCalledWith({ where: { id: scope.intentId },
    data: { status: 'RECONCILIATION_REQUIRED', reconciliationCode: 'ACTIVE_AND_QUARANTINE_MISSING' } });
  expect(f.tx.document.delete).not.toHaveBeenCalled();
});

it('does not probe storage or invent observations for an existing reconciliation-required intent', async () => {
  const f = fixture('RECONCILIATION_REQUIRED');
  (f.intent as any).reconciliationCode = 'untrusted-canary';
  const { record } = await failure(f);
  expect(record).toMatchObject({ reason: 'EXISTING_RECONCILIATION_REQUIRED', activeExists: null,
    quarantineExists: null, reconciliationCode: null, evidenceAvailable: false });
  expect(f.storage.quarantine).not.toHaveBeenCalled(); expect(JSON.stringify(record)).not.toContain('canary');
});

it('distinguishes missing document metadata without accessing storage', async () => {
  const f = fixture(); f.tx.document.findUnique.mockResolvedValue(null);
  expect((await failure(f)).record).toMatchObject({ reason: 'DOCUMENT_ROW_MISSING', activeExists: null });
  expect(f.storage.quarantine).not.toHaveBeenCalled(); expect(f.tx.document.delete).not.toHaveBeenCalled();
});

it('distinguishes quarantine identity mismatch without claiming existence of the expected objects', async () => {
  const f = fixture(); f.storage.quarantine.mockResolvedValue({ result: 'MOVED', quarantineKey: 'unexpected-secret' });
  expect((await failure(f)).record).toMatchObject({ reason: 'QUARANTINE_IDENTITY_MISMATCH',
    quarantineIdentityMatches: false, activeExists: null, quarantineExists: null });
  expect(f.tx.document.delete).not.toHaveBeenCalled();
});

it('preserves original storage and transactional audit failures and their rollback boundary', async () => {
  for (const kind of ['STORAGE_FAILURE', 'DATABASE_FAILURE']) {
    const f = fixture(); const original = new Error('secret-canary');
    if (kind === 'STORAGE_FAILURE') f.storage.quarantine.mockRejectedValue(original);
    else f.tx.auditLog.create.mockRejectedValue(original);
    const { error, record } = await failure(f);
    expect(error).toBe(original); expect(record.reason).toBe(kind);
    expect(JSON.stringify(record)).not.toContain('canary');
    expect(f.guard.withDeletionGuard).toHaveBeenCalledTimes(1);
  }
});

it('never classifies or touches storage when the tenant guard rejects the operation', async () => {
  const f = fixture(); const original = new Error('denied'); f.guard.withDeletionGuard.mockRejectedValue(original);
  const { error } = await failure(f);
  expect(deleteDiagnostic(error, reference, 403)).toMatchObject({ reason: 'AUTHORIZATION_DENIED', intentStatus: null });
  expect(f.storage.quarantine).not.toHaveBeenCalled();
});

it('writes supplemental correlation only to the authorized tenant audit and preserves failure if it fails', async () => {
  const tx = { $executeRaw: jest.fn(), auditLog: { create: jest.fn() } };
  const prisma = { $transaction: jest.fn(async work => work(tx)) };
  const service = new DocumentsService(prisma as any, {} as any, {} as any, {} as any);
  const error = new Error('secret-canary'); attachDeleteFailure(error, emptyDeleteObservation('DATABASE_FAILURE'), scope);
  await service.recordDeleteFailureCorrelation('other-tenant', reference, error);
  expect(prisma.$transaction).not.toHaveBeenCalled();
  await service.recordDeleteFailureCorrelation(scope.organizationId, reference, error);
  expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
    organizationId: scope.organizationId, entityId: scope.intentId, action: 'DOCUMENT_DELETE_DIAGNOSTIC', description: expect.stringContaining(reference) }) }));
  expect(deleteDiagnostic(error, reference, 500).correlationLinkAvailable).toBe(true);
  prisma.$transaction.mockRejectedValue(new Error('failed-audit-canary'));
  await expect(service.recordDeleteFailureCorrelation(scope.organizationId, reference, error)).resolves.toBeUndefined();
  expect(deleteDiagnostic(error, reference, 500).correlationLinkAvailable).toBe(false);
});

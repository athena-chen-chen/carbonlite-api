import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DeletionRecoveryService } from './deletion-recovery.service';

function subject(document = {
  id: 'doc-a',
  organizationId: 'org-a',
  fileUrl: 'spreadsheet-import://synthetic-batch',
}) {
  const tx = {
    document: {
      findUnique: jest.fn().mockResolvedValue(document),
      delete: jest.fn().mockResolvedValue(document),
    },
    activityData: { count: jest.fn().mockResolvedValue(5) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    userActivityEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const legalHolds = {
    withDeletionGuard: jest.fn(
      async (_input: unknown, work: (client: typeof tx) => unknown) => work(tx),
    ),
  };
  const storage = { quarantine: jest.fn() };
  const service = new DeletionRecoveryService(
    {} as never,
    storage as never,
    legalHolds as never,
  );
  return { service, tx, storage, legalHolds };
}

describe('DeletionRecoveryService virtual spreadsheet deletion', () => {
  it('deletes only database source metadata and records preserved activities', async () => {
    const { service, tx, storage, legalHolds } = subject();

    await expect(service.deleteVirtualDocument('org-a', 'doc-a', 'user-a'))
      .resolves.toEqual({ preservedActivityRecords: 5 });

    expect(legalHolds.withDeletionGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-a',
        operation: 'DELETE_DOCUMENT',
        documentIds: ['doc-a'],
      }),
      expect.any(Function),
    );
    expect(tx.document.delete).toHaveBeenCalledWith({ where: { id: 'doc-a' } });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'DELETE_DOCUMENT',
        entityId: 'doc-a',
        newValue: {
          documentId: 'doc-a',
          preservedActivityRecords: 5,
          sourceEvidence: 'NONE',
        },
      }),
    });
    expect(storage.quarantine).not.toHaveBeenCalled();
  });

  it('preserves cross-tenant authorization', async () => {
    const { service, tx } = subject({
      id: 'doc-a',
      organizationId: 'org-b',
      fileUrl: 'spreadsheet-import://synthetic-batch',
    });

    await expect(service.deleteVirtualDocument('org-a', 'doc-a', 'user-a'))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.document.delete).not.toHaveBeenCalled();
  });

  it('preserves legal-hold denial without deleting metadata', async () => {
    const { service, tx, legalHolds } = subject();
    legalHolds.withDeletionGuard.mockRejectedValueOnce(
      new ConflictException('Deletion is temporarily restricted.'),
    );

    await expect(service.deleteVirtualDocument('org-a', 'doc-a', 'user-a'))
      .rejects.toBeInstanceOf(ConflictException);
    expect(tx.document.findUnique).not.toHaveBeenCalled();
    expect(tx.document.delete).not.toHaveBeenCalled();
  });
});

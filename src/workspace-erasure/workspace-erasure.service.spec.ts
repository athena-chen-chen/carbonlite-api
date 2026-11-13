import { UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.service';
import type { DocumentStorage } from '../documents/document-storage';
import { WorkspaceErasureService } from './workspace-erasure.service';

const platformAdmin: AuthenticatedUser = {
  id: 'platform-admin',
  email: 'operator@example.test',
  organizationId: 'operator-org',
  organizationName: 'Operator',
  role: UserRole.ADMIN,
  platformRole: UserRole.ADMIN,
  accountType: 'CUSTOMER',
};

function storageMock(): jest.Mocked<DocumentStorage> {
  return {
    save: jest.fn(), read: jest.fn(), exists: jest.fn(),
    quarantine: jest.fn(), quarantineExists: jest.fn(), purgeQuarantine: jest.fn(),
    listActive: jest.fn().mockResolvedValue([]), listQuarantine: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue('DELETED'), verifyHealth: jest.fn(),
  } as jest.Mocked<DocumentStorage>;
}

function setup() {
  const organization = { id: 'org-a', slug: 'workspace-a' };
  const tx = {
    organization: {
      findUnique: jest.fn().mockResolvedValue(organization),
      delete: jest.fn().mockResolvedValue({ id: 'org-a' }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'completed-audit' }) },
    documentDeletionIntent: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
  };
  const count = (value = 1) => ({ count: jest.fn().mockResolvedValue(value) });
  const prisma: any = {
    organization: { findUnique: jest.fn().mockResolvedValue(organization) },
    user: count(2), membership: count(2), facility: count(1), asset: count(1),
    document: {
      findMany: jest.fn().mockImplementation(({ select }) => Promise.resolve(
        select.fileUrl
          ? [
              { id: 'document-a', fileUrl: '/uploads/org-a/a.pdf' },
              { id: 'document-b', fileUrl: '/uploads/org-a/b.csv' },
            ]
          : [{ importBatchId: 'batch-a' }],
      )),
    },
    documentExtraction: count(2), spreadsheetImportReviewRow: count(3),
    activityData: {
      count: jest.fn().mockImplementation(({ where }) => Promise.resolve(where.calculationVersion ? 3 : 4)),
      findMany: jest.fn().mockResolvedValue([{ importBatchId: 'batch-a' }]),
    },
    metricResult: count(4),
    report: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([]),
    },
    aIJob: count(1), conversionFactor: count(1), feedback: count(1),
    userActivityEvent: count(2),
    organizationQuota: count(1), organizationQuotaPeriod: count(1),
    organizationQuotaUsage: count(2), organizationAiAuthorization: count(1),
    auditLog: {
      count: jest.fn().mockResolvedValue(2),
      create: jest.fn().mockResolvedValue({ id: 'audit' }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    factor: { deleteMany: jest.fn() },
    factorVersion: { deleteMany: jest.fn() },
    factorSource: { deleteMany: jest.fn() },
    $transaction: jest.fn((work) => work(tx)),
  };
  Object.assign(tx, {
    user: prisma.user,
    membership: prisma.membership,
    facility: prisma.facility,
    asset: prisma.asset,
    document: prisma.document,
    documentExtraction: prisma.documentExtraction,
    spreadsheetImportReviewRow: prisma.spreadsheetImportReviewRow,
    activityData: prisma.activityData,
    metricResult: prisma.metricResult,
    report: prisma.report,
    aIJob: prisma.aIJob,
    conversionFactor: prisma.conversionFactor,
    feedback: prisma.feedback,
    userActivityEvent: prisma.userActivityEvent,
    organizationQuota: prisma.organizationQuota,
    organizationQuotaPeriod: prisma.organizationQuotaPeriod,
    organizationQuotaUsage: prisma.organizationQuotaUsage,
    organizationAiAuthorization: prisma.organizationAiAuthorization,
    auditLog: { ...prisma.auditLog, create: tx.auditLog.create },
  });
  const storage = storageMock();
  const legalHolds = {
    withDeletionGuard: jest.fn((_input, work) => prisma.$transaction(work)),
  };
  const recovery = {
    prepareWorkspaceInTransaction: jest.fn().mockImplementation((_tx, _organizationId, items: { storageKey: string }[]) =>
      Promise.resolve(items.map((item: { storageKey: string }, index: number) => ({
        id: `intent-${index}`, storageKey: item.storageKey,
        quarantineKey: `.quarantine/intent-${index}/file`, status: 'PREPARED',
      })))),
    quarantinePreparedIntent: jest.fn().mockResolvedValue(true),
  };
  return {
    prisma, storage, tx, recovery,
    service: new WorkspaceErasureService(prisma, storage, legalHolds as never, recovery as never),
  };
}

const command = {
  organizationId: 'org-a',
  confirmationOrganizationId: 'org-a',
  confirmationOrganizationSlug: 'workspace-a',
  confirmErase: true as const,
};

describe('WorkspaceErasureService', () => {
  it('builds a comprehensive dry-run inventory without changing storage or data', async () => {
    const { service, prisma, storage } = setup();
    await expect(service.dryRun(platformAdmin, 'org-a')).resolves.toMatchObject({
      status: 'DRY_RUN',
      dataDeleted: false,
      inventory: {
        organizationId: 'org-a', documents: 2, physicalFiles: 2,
        activityRecords: 4, calculationSnapshots: 3, importBatches: 1,
        customConversionFactors: 1,
        quotaPolicies: 1, quotaPeriods: 1, quotaUsages: 2,
        aiAuthorizations: 1,
      },
    });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('blocks ordinary and tenant-admin callers before target lookup', async () => {
    const { service, prisma } = setup();
    const tenantAdmin = { ...platformAdmin, id: 'tenant-admin', organizationId: 'org-b', platformRole: UserRole.USER };
    await expect(service.dryRun(tenantAdmin, 'org-a')).rejects.toThrow('platform administrator');
    expect(prisma.organization.findUnique).not.toHaveBeenCalled();
  });

  it('blocks erasing the operator active workspace', async () => {
    const { service } = setup();
    await expect(service.dryRun({ ...platformAdmin, organizationId: 'org-a' }, 'org-a'))
      .rejects.toThrow('active workspace');
  });

  it('requires exact id, slug, and destructive confirmation', async () => {
    const { service, storage } = setup();
    await expect(service.erase(platformAdmin, { ...command, confirmationOrganizationId: 'org-b' }))
      .rejects.toThrow('Exact organization confirmation');
    await expect(service.erase(platformAdmin, { ...command, confirmationOrganizationSlug: 'wrong' }))
      .rejects.toThrow('Exact organization slug');
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('quarantines only target storage keys and deletes the target organization, preserving global factors', async () => {
    const { service, prisma, storage, tx, recovery } = setup();
    await expect(service.erase(platformAdmin, command)).resolves.toMatchObject({
      status: 'ERASED', quarantinedPhysicalFiles: 2,
    });
    expect(recovery.quarantinePreparedIntent).toHaveBeenCalledTimes(2);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(tx.organization.delete).toHaveBeenCalledWith({ where: { id: 'org-a' } });
    expect(prisma.factor.deleteMany).not.toHaveBeenCalled();
    expect(prisma.factorVersion.deleteMany).not.toHaveBeenCalled();
    expect(prisma.factorSource.deleteMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organizationId: null, userId: 'platform-admin', action: 'WORKSPACE_ERASURE_COMPLETED' }),
    }));
  });

  it('leaves tenant B physical evidence and database boundary untouched', async () => {
    const { service, storage, tx, recovery } = setup();

    await service.erase(platformAdmin, command);

    expect(recovery.prepareWorkspaceInTransaction).toHaveBeenCalledWith(
      expect.anything(), 'org-a', expect.not.arrayContaining([expect.objectContaining({ storageKey: 'org-b/private.pdf' })]), 'platform-admin',
    );
    expect(storage.delete).not.toHaveBeenCalled();
    expect(tx.organization.delete).toHaveBeenCalledTimes(1);
    expect(tx.organization.delete).not.toHaveBeenCalledWith({ where: { id: 'org-b' } });
  });

  it('keeps database data when quarantine rename fails from storage exhaustion', async () => {
    const { service, prisma, tx, recovery } = setup();
    const storageFull = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    recovery.quarantinePreparedIntent.mockRejectedValueOnce(storageFull);
    await expect(service.erase(platformAdmin, command)).rejects.toThrow('Database data was retained');
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.organization.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'WORKSPACE_ERASURE_STORAGE_FAILED' }),
    }));
  });

  it('fails closed when active and quarantine copies are both missing', async () => {
    const { service, recovery } = setup();
    recovery.quarantinePreparedIntent.mockResolvedValueOnce(false);
    await expect(service.erase(platformAdmin, command)).rejects.toThrow('Database data was retained');
  });

  it('surfaces a DB failure after recoverable movement and supports idempotent retry', async () => {
    const { service, recovery, tx } = setup();
    tx.organization.delete
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({ id: 'org-a' });

    await expect(service.erase(platformAdmin, command)).rejects.toThrow('recoverable quarantine movement');
    await expect(service.erase(platformAdmin, command)).resolves.toMatchObject({
      status: 'ERASED', quarantinedPhysicalFiles: 2,
    });
    expect(recovery.quarantinePreparedIntent).toHaveBeenCalledTimes(4);
    expect(tx.organization.delete).toHaveBeenCalledWith({ where: { id: 'org-a' } });
  });

  it('returns explicit already-erased status without touching another tenant', async () => {
    const { service, prisma, storage, tx } = setup();
    tx.organization.findUnique.mockResolvedValue(null);
    prisma.auditLog.findFirst.mockResolvedValue({ id: 'completed' });
    await expect(service.erase(platformAdmin, command)).resolves.toMatchObject({ status: 'ALREADY_ERASED' });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('fails closed for unknown workspace ids', async () => {
    const { service, tx } = setup();
    tx.organization.findUnique.mockResolvedValue(null);
    await expect(service.erase(platformAdmin, command)).rejects.toThrow('Organization not found');
  });
});

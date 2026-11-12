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
    delete: jest.fn().mockResolvedValue('DELETED'), verifyHealth: jest.fn(),
  } as jest.Mocked<DocumentStorage>;
}

function setup() {
  const organization = { id: 'org-a', slug: 'workspace-a' };
  const tx = {
    organization: {
      findUnique: jest.fn().mockResolvedValue({ id: 'org-a' }),
      delete: jest.fn().mockResolvedValue({ id: 'org-a' }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'completed-audit' }) },
  };
  const count = (value = 1) => ({ count: jest.fn().mockResolvedValue(value) });
  const prisma: any = {
    organization: { findUnique: jest.fn().mockResolvedValue(organization) },
    user: count(2), membership: count(2), facility: count(1), asset: count(1),
    document: {
      findMany: jest.fn().mockImplementation(({ select }) => Promise.resolve(
        select.fileUrl
          ? [{ fileUrl: '/uploads/org-a/a.pdf' }, { fileUrl: '/uploads/org-a/b.csv' }]
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
  const storage = storageMock();
  return { prisma, storage, tx, service: new WorkspaceErasureService(prisma, storage) };
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

  it('deletes only target storage keys and the target organization, preserving global factors', async () => {
    const { service, prisma, storage, tx } = setup();
    await expect(service.erase(platformAdmin, command)).resolves.toMatchObject({
      status: 'ERASED', deletedPhysicalFiles: 2, alreadyMissingPhysicalFiles: 0,
    });
    expect(storage.delete.mock.calls.map(([key]) => key)).toEqual(['org-a/a.pdf', 'org-a/b.csv']);
    expect(tx.organization.delete).toHaveBeenCalledWith({ where: { id: 'org-a' } });
    expect(prisma.factor.deleteMany).not.toHaveBeenCalled();
    expect(prisma.factorVersion.deleteMany).not.toHaveBeenCalled();
    expect(prisma.factorSource.deleteMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organizationId: null, userId: 'platform-admin', action: 'WORKSPACE_ERASURE_COMPLETED' }),
    }));
  });

  it('leaves tenant B physical evidence and database boundary untouched', async () => {
    const { service, storage, tx } = setup();
    const physicalObjects = new Set(['org-a/a.pdf', 'org-a/b.csv', 'org-b/private.pdf']);
    storage.delete.mockImplementation(async (key) => physicalObjects.delete(key) ? 'DELETED' : 'NOT_FOUND');

    await service.erase(platformAdmin, command);

    expect(physicalObjects).toEqual(new Set(['org-b/private.pdf']));
    expect(tx.organization.delete).toHaveBeenCalledTimes(1);
    expect(tx.organization.delete).not.toHaveBeenCalledWith({ where: { id: 'org-b' } });
  });

  it('keeps database data when physical deletion fails and records incomplete status', async () => {
    const { service, prisma, storage, tx } = setup();
    storage.delete.mockRejectedValueOnce(new Error('object store unavailable'));
    await expect(service.erase(platformAdmin, command)).rejects.toThrow('Database data was retained');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.organization.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'WORKSPACE_ERASURE_STORAGE_FAILED' }),
    }));
  });

  it('continues safely when physical files are already missing', async () => {
    const { service, storage } = setup();
    storage.delete.mockResolvedValue('NOT_FOUND');
    await expect(service.erase(platformAdmin, command)).resolves.toMatchObject({
      status: 'ERASED', deletedPhysicalFiles: 0, alreadyMissingPhysicalFiles: 2,
    });
  });

  it('surfaces DB failure after storage cleanup and supports a safe retry', async () => {
    const { service, prisma, storage, tx } = setup();
    prisma.$transaction
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockImplementationOnce((work: (client: typeof tx) => unknown) => work(tx));
    storage.delete
      .mockResolvedValueOnce('DELETED').mockResolvedValueOnce('DELETED')
      .mockResolvedValue('NOT_FOUND');

    await expect(service.erase(platformAdmin, command)).rejects.toThrow('Retry is safe');
    await expect(service.erase(platformAdmin, command)).resolves.toMatchObject({
      status: 'ERASED', alreadyMissingPhysicalFiles: 2,
    });
    expect(tx.organization.delete).toHaveBeenCalledWith({ where: { id: 'org-a' } });
  });

  it('returns explicit already-erased status without touching another tenant', async () => {
    const { service, prisma, storage } = setup();
    prisma.organization.findUnique.mockResolvedValue(null);
    prisma.auditLog.findFirst.mockResolvedValue({ id: 'completed' });
    await expect(service.erase(platformAdmin, command)).resolves.toMatchObject({ status: 'ALREADY_ERASED' });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fails closed for unknown workspace ids', async () => {
    const { service, prisma } = setup();
    prisma.organization.findUnique.mockResolvedValue(null);
    await expect(service.erase(platformAdmin, command)).rejects.toThrow('Organization not found');
  });
});

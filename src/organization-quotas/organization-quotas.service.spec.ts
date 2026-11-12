import { OrganizationQuotasService } from './organization-quotas.service';
import { QuotaExceededException } from './quota-errors';

const enabledPolicy = {
  organizationId: 'org-a',
  enabled: true,
  periodDays: 28,
  uploadLimit: 20,
  dailyUploadLimit: 10,
  maxFileSizeBytes: 10 * 1024 * 1024,
  maxConcurrentExtractions: 2,
  maxImportRows: 500,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  organization: { isActive: true, customerStatus: 'ACTIVE' },
};

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ pg_advisory_xact_lock: '' }]),
    organizationQuota: {
      findUnique: jest.fn().mockResolvedValue(enabledPolicy),
      upsert: jest.fn().mockResolvedValue(enabledPolicy),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ id: 'org-a', isActive: true, customerStatus: 'ACTIVE' }),
    },
    organizationQuotaPeriod: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'period-a', organizationId: 'org-a',
        startsAt: new Date('2026-01-01T00:00:00Z'),
        endsAt: new Date('2026-01-29T00:00:00Z'), closedAt: null,
      }),
      create: jest.fn(), update: jest.fn(),
    },
    organizationQuotaUsage: {
      count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({ id: 'usage-a' }),
    },
    aIJob: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'job-a' }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-a' }) },
    ...overrides,
  } as any;
}

function subject(tx: any) {
  const prisma = {
    $transaction: jest.fn(async (work: (client: any) => unknown) => work(tx)),
    organizationQuota: tx.organizationQuota,
    aIJob: tx.aIJob,
  } as any;
  return { service: new OrganizationQuotasService(prisma), prisma };
}

describe('OrganizationQuotasService', () => {
  it('owns the upload transaction and locks the organization before admission', async () => {
    const tx = transaction();
    const { service, prisma } = subject(tx);

    await service.withUploadTransaction(
      {
        organizationId: 'org-a',
        userId: 'user-a',
        fileSize: 42,
        now: new Date('2026-01-02T00:00:00Z'),
      },
      async () => ({
        value: { id: 'doc-a' },
        accepted: true,
        documentId: 'doc-a',
        metadata: { source: 'DOCUMENT_UPLOAD' },
      }),
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.organizationQuotaUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-a',
        userId: 'user-a',
        documentId: 'doc-a',
      }),
    });
  });

  it('leaves organizations without an enabled policy unchanged', async () => {
    const tx = transaction();
    tx.organizationQuota.findUnique.mockResolvedValue({ ...enabledPolicy, enabled: false });
    const { service } = subject(tx);

    const result = await service.withUploadAcceptance(
      tx,
      { organizationId: 'org-a', userId: 'user-a', fileSize: 100 },
      async () => ({ value: { id: 'doc-a' }, accepted: true, documentId: 'doc-a' }),
    );

    expect(result).toEqual({ id: 'doc-a' });
    expect(tx.organizationQuotaUsage.create).not.toHaveBeenCalled();
  });

  it('serializes admission and records accepted uploads for the authenticated organization', async () => {
    const tx = transaction();
    const { service } = subject(tx);

    await service.withUploadAcceptance(
      tx,
      { organizationId: 'org-a', userId: 'user-a', fileSize: 42, now: new Date('2026-01-02T12:00:00Z') },
      async () => ({ value: { id: 'doc-a' }, accepted: true, documentId: 'doc-a' }),
    );

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.organizationQuotaUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-a', userId: 'user-a', documentId: 'doc-a',
      }),
    });
  });

  it('does not consume quota when acceptance fails', async () => {
    const tx = transaction();
    const { service } = subject(tx);

    await expect(service.withUploadAcceptance(
      tx,
      { organizationId: 'org-a', userId: 'user-a', fileSize: 42 },
      async () => { throw new Error('storage or document failure'); },
    )).rejects.toThrow('storage or document failure');
    expect(tx.organizationQuotaUsage.create).not.toHaveBeenCalled();
  });

  it('blocks a suspended organization before accepting or consuming quota', async () => {
    const tx = transaction();
    tx.organizationQuota.findUnique.mockResolvedValue({
      ...enabledPolicy,
      organization: { isActive: true, customerStatus: 'SUSPENDED' },
    });
    const accept = jest.fn();
    const { service } = subject(tx);

    await expect(service.withUploadAcceptance(
      tx,
      { organizationId: 'org-a', userId: 'user-a', fileSize: 42 },
      accept,
    )).rejects.toThrow('Organization access is unavailable');
    expect(accept).not.toHaveBeenCalled();
    expect(tx.organizationQuotaUsage.create).not.toHaveBeenCalled();
  });

  it('rejects the period limit without leaking tenant details', async () => {
    const tx = transaction();
    tx.organizationQuotaUsage.count
      .mockResolvedValueOnce(enabledPolicy.uploadLimit)
      .mockResolvedValueOnce(0);
    const { service } = subject(tx);

    const error = await service.withUploadAcceptance(
      tx,
      { organizationId: 'org-a', userId: 'user-a', now: new Date('2026-01-02T00:00:00Z') },
      async () => ({ value: { id: 'doc-a' }, accepted: true, documentId: 'doc-a' }),
    ).catch((caught) => caught);

    if (!(error instanceof QuotaExceededException)) throw error;
    expect(error).toBeInstanceOf(QuotaExceededException);
    expect(error.getResponse()).toMatchObject({
      code: 'UPLOAD_PERIOD_QUOTA_EXCEEDED', limit: 20, remaining: 0,
    });
    expect(JSON.stringify(error.getResponse())).not.toContain('org-a');
    expect(tx.organizationQuotaUsage.create).not.toHaveBeenCalled();
  });

  it('closes an expired period and starts a new period without deleting usage', async () => {
    const tx = transaction();
    tx.organizationQuotaPeriod.findFirst.mockResolvedValue({
      id: 'expired', organizationId: 'org-a',
      startsAt: new Date('2025-12-01T00:00:00Z'),
      endsAt: new Date('2025-12-29T00:00:00Z'), closedAt: null,
    });
    tx.organizationQuotaPeriod.create.mockResolvedValue({
      id: 'period-new', organizationId: 'org-a',
      startsAt: new Date('2026-01-02T00:00:00Z'),
      endsAt: new Date('2026-01-30T00:00:00Z'), closedAt: null,
    });
    const { service } = subject(tx);

    await service.withUploadAcceptance(
      tx,
      { organizationId: 'org-a', now: new Date('2026-01-02T00:00:00Z') },
      async () => ({ value: { id: 'doc-a' }, accepted: true, documentId: 'doc-a' }),
    );

    expect(tx.organizationQuotaPeriod.update).toHaveBeenCalledWith({
      where: { id: 'expired' }, data: { closedAt: new Date('2026-01-02T00:00:00Z') },
    });
    expect(tx.organizationQuotaPeriod.create).toHaveBeenCalled();
  });

  it('uses the organization timezone for daily upload boundaries', async () => {
    const tx = transaction();
    tx.organization.findUnique.mockResolvedValue({
      id: 'org-a', customerStatus: 'ACTIVE', timezone: 'America/Edmonton',
    });
    const { service } = subject(tx);
    const now = new Date('2026-01-02T02:00:00Z');

    await service.withUploadAcceptance(
      tx,
      { organizationId: 'org-a', now },
      async () => ({ value: { id: 'doc-a' }, accepted: true, documentId: 'doc-a' }),
    );

    expect(tx.organizationQuotaUsage.count).toHaveBeenNthCalledWith(2, {
      where: {
        periodId: 'period-a',
        usageType: 'DOCUMENT_UPLOAD',
        occurredAt: {
          gte: new Date('2026-01-01T07:00:00Z'),
          lte: now,
        },
      },
    });
  });

  it('enforces row limits only for enabled quota organizations', async () => {
    const tx = transaction();
    const { service } = subject(tx);
    await expect(service.assertImportRows('org-a', 501)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'IMPORT_ROW_QUOTA_EXCEEDED', limit: 500 }),
    });

    tx.organizationQuota.findUnique.mockResolvedValue({ enabled: false, maxImportRows: 500 });
    await expect(service.assertImportRows('org-demo', 501)).resolves.toBeUndefined();
  });

  it('claims extraction capacity per tenant and recovers expired leases', async () => {
    const tx = transaction();
    tx.aIJob.count.mockResolvedValue(1);
    const { service } = subject(tx);
    const now = new Date('2026-01-02T00:00:00Z');

    await service.beginExtraction({
      organizationId: 'org-a', documentId: 'doc-a', userId: 'user-a', now,
    });

    expect(tx.aIJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ organizationId: 'org-a' }),
    }));
    expect(tx.aIJob.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ organizationId: 'org-a' }),
    });
    expect(tx.aIJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-a', documentId: 'doc-a', createdById: 'user-a',
        leaseExpiresAt: new Date('2026-01-02T00:02:00Z'),
      }),
      select: { id: true },
    });
  });

  it('rejects only when the same organization has exhausted extraction slots', async () => {
    const tx = transaction();
    tx.aIJob.count.mockResolvedValue(2);
    const { service } = subject(tx);

    await expect(service.beginExtraction({
      organizationId: 'org-b', documentId: 'doc-b', now: new Date('2026-01-02T00:00:00Z'),
    })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'EXTRACTION_CONCURRENCY_EXCEEDED' }),
    });
    expect(tx.aIJob.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ organizationId: 'org-b' }),
    });
  });

  it('audits configuration and opens the first period when quotas are enabled', async () => {
    const tx = transaction();
    tx.organizationQuota.findUnique.mockResolvedValue(null);
    tx.organizationQuotaPeriod.findFirst.mockResolvedValue(null);
    const { service } = subject(tx);
    const now = new Date('2026-01-02T00:00:00Z');

    await service.configure('org-a', 'admin-a', { enabled: true }, now);

    expect(tx.organizationQuota.upsert).toHaveBeenCalledWith({
      where: { organizationId: 'org-a' },
      create: { organizationId: 'org-a', enabled: true },
      update: { enabled: true },
    });
    expect(tx.organizationQuotaPeriod.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-a', startsAt: now,
        endsAt: new Date('2026-01-30T00:00:00Z'),
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-a', userId: 'admin-a',
        action: 'ORGANIZATION_QUOTA_CONFIGURED',
      }),
    });
  });

  it('refuses to enable paid-pilot quotas for demo organizations', async () => {
    const tx = transaction();
    tx.organization.findUnique.mockResolvedValue({ id: 'org-demo', customerStatus: 'DEMO' });
    const { service } = subject(tx);

    await expect(service.configure('org-demo', 'admin-a', { enabled: true }))
      .rejects.toThrow('paid-pilot customer organization');
    expect(tx.organizationQuota.upsert).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

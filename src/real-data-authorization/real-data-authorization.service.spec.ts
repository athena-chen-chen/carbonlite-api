import {
  AiAuthorizedDataMode,
  AiAuthorizationStatus,
  OrganizationCustomerStatus,
  RealDataAuthorizationStatus,
} from '@prisma/client';
import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { RealDataAuthorizationService } from './real-data-authorization.service';

const hmacKey = Buffer.alloc(32, 7).toString('base64');

function effectiveAuthorization(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-a',
    decisionId: 'decision-a',
    status: RealDataAuthorizationStatus.REAL_DATA_APPROVED,
    approvalRevision: 1,
    policyVersion: '0.2',
    agreementEvidenceReference: 'agreement-1',
    allowedDataScopeReference: 'scope-1',
    privacySecurityReadinessReference: 'readiness-1',
    approvedById: 'admin-a',
    approvedAt: new Date('2026-11-13T18:00:00Z'),
    effectiveAt: new Date('2026-11-13T18:00:00Z'),
    expiresAt: null,
    reviewDueAt: new Date('2099-01-01T00:00:00Z'),
    withdrawnById: null,
    withdrawnAt: null,
    withdrawalReason: null,
    organization: { isActive: true, customerStatus: OrganizationCustomerStatus.ACTIVE },
    ...overrides,
  };
}

function setup() {
  const authorization = {
    findUnique: jest.fn().mockResolvedValue(null),
    upsert: jest.fn(),
    update: jest.fn(),
  };
  const aiAuthorization = {
    findUnique: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
  };
  const tx: any = {
    organizationRealDataAuthorization: authorization,
    organizationAiAuthorization: aiAuthorization,
    realDataAuthorizationEvidence: {
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'evidence-a', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'org-a',
        slug: 'org-a',
        isActive: true,
        customerStatus: OrganizationCustomerStatus.ACTIVE,
        provisionedAt: new Date(),
        allowDemoFactorsForCalculations: false,
        quotaPolicy: { enabled: true },
      }),
    },
    membership: { findFirst: jest.fn().mockResolvedValue({ id: 'membership-a' }) },
    activityData: { count: jest.fn().mockResolvedValue(0) },
    report: { count: jest.fn().mockResolvedValue(0) },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-a' }) },
  };
  const prisma: any = {
    ...tx,
    $transaction: jest.fn((work) => work(tx)),
  };
  const auditLog = {
    log: jest.fn().mockImplementation((input) => tx.auditLog.create({ data: input })),
  };
  const service = new RealDataAuthorizationService(prisma, auditLog as never);
  return { service, prisma, tx, authorization, aiAuthorization, auditLog };
}

describe('RealDataAuthorizationService', () => {
  beforeEach(() => {
    process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION = 'test-v1';
    process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING = JSON.stringify([
      { version: 'test-v1', key: `base64:${hmacKey}` },
    ]);
  });

  afterEach(() => {
    delete process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION;
    delete process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING;
  });

  it('resolves a missing authorization to synthetic-only', async () => {
    const { service } = setup();
    await expect(service.getCustomerStatus('org-a')).resolves.toMatchObject({
      effectiveMode: 'SYNTHETIC_ONLY',
      configuredStatus: 'NOT_CONFIGURED',
      reason: 'NOT_CONFIGURED',
    });
  });

  it('fails customer status closed when lookup fails', async () => {
    const { service, authorization } = setup();
    authorization.findUnique.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.getCustomerStatus('org-a')).resolves.toMatchObject({
      effectiveMode: 'SYNTHETIC_ONLY',
      reason: 'STATUS_LOOKUP_FAILED',
    });
  });

  it('temporarily defaults a missing old-client mode only for a synthetic organization', async () => {
    const { service, auditLog } = setup();
    await expect(service.resolveIngestionMode('org-a', undefined, 'user-a')).resolves.toBe('SYNTHETIC_TEST');
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'INGESTION_DATA_MODE_DEFAULTED' }));
  });

  it('rejects missing mode for an effectively approved organization', async () => {
    const { service, authorization } = setup();
    authorization.findUnique.mockResolvedValueOnce(effectiveAuthorization());
    await expect(service.resolveIngestionMode('org-a', undefined, 'user-a')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects real-customer-data mode for a synthetic organization', async () => {
    const { service } = setup();
    await expect(service.resolveIngestionMode('org-a', 'REAL_CUSTOMER_DATA', 'user-a')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails ingestion closed when the authorization lookup fails', async () => {
    const { service, authorization } = setup();
    authorization.findUnique.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.resolveIngestionMode('org-a', 'SYNTHETIC_TEST', 'user-a')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('approves once, writes HMAC evidence, and returns an identical request idempotently', async () => {
    const { service, authorization, tx } = setup();
    const created = effectiveAuthorization();
    delete (created as any).organization;
    authorization.upsert.mockResolvedValueOnce(created);
    const dto = {
      organizationId: 'org-a',
      confirmationOrganizationId: 'org-a',
      confirmationOrganizationSlug: 'org-a',
      confirmRealDataApproval: true as const,
      policyVersion: '0.2',
      agreementEvidenceReference: 'agreement-1',
      allowedDataScopeReference: 'scope-1',
      privacySecurityReadinessReference: 'readiness-1',
      effectiveAt: '2026-11-13T18:00:00.000Z',
      reviewDueAt: '2099-01-01T00:00:00.000Z',
    };
    await expect(service.approve('org-a', 'admin-a', dto)).resolves.toMatchObject({ result: 'APPROVED' });
    expect(tx.realDataAuthorizationEvidence.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        hmacKeyVersion: 'test-v1',
        organizationIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        agreementEvidenceReferenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    authorization.findUnique.mockResolvedValueOnce(created);
    await expect(service.approve('org-a', 'admin-a', dto)).resolves.toMatchObject({ result: 'ALREADY_APPROVED' });
    expect(authorization.upsert).toHaveBeenCalledTimes(1);
  });

  it('withdraws only a real-customer-data AI authorization transactionally', async () => {
    const { service, authorization, aiAuthorization } = setup();
    const approved = effectiveAuthorization();
    delete (approved as any).organization;
    authorization.findUnique.mockResolvedValueOnce(approved);
    authorization.update.mockResolvedValueOnce({
      ...approved,
      status: RealDataAuthorizationStatus.WITHDRAWN,
      withdrawnAt: new Date(),
      withdrawnById: 'admin-a',
    });
    aiAuthorization.findUnique.mockResolvedValueOnce({
      status: AiAuthorizationStatus.ENABLED,
      authorizedDataMode: AiAuthorizedDataMode.REAL_CUSTOMER_DATA,
    });
    aiAuthorization.update.mockResolvedValueOnce({});
    await expect(service.withdraw('org-a', 'admin-a', {
      organizationId: 'org-a',
      confirmationOrganizationId: 'org-a',
      confirmationOrganizationSlug: 'org-a',
      confirmWithdrawal: true,
      withdrawalReason: 'Pilot ended',
    })).resolves.toMatchObject({ result: 'WITHDRAWN' });
    expect(aiAuthorization.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: AiAuthorizationStatus.WITHDRAWN }),
    }));
  });

  it('rejects a stale real-data approval revision', async () => {
    const { service, authorization } = setup();
    authorization.findUnique.mockResolvedValueOnce(effectiveAuthorization({ approvalRevision: 3 }));
    await expect(service.assertEffectiveRealDataApproval('org-a', 2)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails an approval assertion closed when persisted state cannot be read', async () => {
    const { service, authorization } = setup();
    authorization.findUnique.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.assertEffectiveRealDataApproval('org-a')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not require evidence hashing when erasing an organization that was never approved', async () => {
    const { service, tx, authorization } = setup();
    authorization.findUnique.mockResolvedValueOnce(null);
    delete process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION;
    delete process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING;
    await expect(
      service.markWorkspaceErased(tx, 'synthetic-org', new Date('2026-11-13T20:00:00Z')),
    ).resolves.toEqual({ count: 0 });
    expect(tx.realDataAuthorizationEvidence.updateMany).not.toHaveBeenCalled();
  });

  it('marks historical evidence by immutable decision ID after key rotation', async () => {
    const { service, tx, authorization } = setup();
    authorization.findUnique.mockResolvedValueOnce({ decisionId: 'historical-decision' });
    process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION = 'test-v2';
    process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING = JSON.stringify([
      { version: 'test-v2', key: `base64:${Buffer.alloc(32, 8).toString('base64')}` },
    ]);
    const erasedAt = new Date('2026-11-13T20:00:00Z');
    await expect(service.markWorkspaceErased(tx, 'org-a', erasedAt)).resolves.toEqual({ count: 1 });
    expect(tx.realDataAuthorizationEvidence.updateMany).toHaveBeenCalledWith({
      where: { authorizationDecisionId: 'historical-decision' },
      data: { workspaceErasedAt: erasedAt },
    });
  });
});

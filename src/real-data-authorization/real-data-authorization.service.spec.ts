import {
  AiAuthorizedDataMode,
  AiAuthorizationStatus,
  OrganizationCustomerStatus,
  RealDataAuthorizationStatus,
} from '@prisma/client';
import { ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { RealDataAuthorizationService } from './real-data-authorization.service';

const hmacKey = Buffer.alloc(32, 7).toString('base64');

function effectiveAuthorization(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-a',
    decisionId: 'decision-a',
    status: RealDataAuthorizationStatus.REAL_DATA_APPROVED,
    approvalRevision: 1,
    policyVersion: 'CARBONLITE_ALLOWED_DATA_POLICY_V0_2',
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
    $queryRaw: jest.fn().mockResolvedValue([{ locked: 1 }]),
    organizationRealDataAuthorization: authorization,
    organizationAiAuthorization: aiAuthorization,
    realDataAuthorizationEvidence: {
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'evidence-a', ...data })),
      findMany: jest.fn().mockResolvedValue([]),
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
    delete process.env.REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS;
  });

  afterEach(() => {
    delete process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION;
    delete process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING;
    delete process.env.REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS;
    jest.restoreAllMocks();
  });

  it('validates HMAC configuration at service startup and logs only safe metadata', () => {
    process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION = 'test-v2';
    process.env.REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS = JSON.stringify({
      'test-v2': `base64:${Buffer.alloc(32, 8).toString('base64')}`,
    });
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    setup();

    expect(log).toHaveBeenCalledWith(
      'Evidence HMAC loaded: active=test-v2 versions=[test-v1,test-v2] count=2 legacy=YES additive=YES',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(hmacKey);
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      Buffer.alloc(32, 8).toString('base64'),
    );
  });

  it('fails service startup closed when no HMAC configuration exists', () => {
    delete process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION;
    delete process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING;

    expect(() => setup()).toThrow(ServiceUnavailableException);
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
    const { service, authorization, auditLog } = setup();
    authorization.findUnique.mockResolvedValueOnce(effectiveAuthorization());
    await expect(service.resolveIngestionMode('org-a', undefined, 'user-a')).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        code: 'DATA_MODE_REQUIRED',
        message: 'Ingestion data mode is required.',
      }),
    });
    expect(auditLog.log).not.toHaveBeenCalled();
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
      policyVersion: 'CARBONLITE_ALLOWED_DATA_POLICY_V0_2',
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

  it.each(['0.2', 'latest', 'customer-policy-v2'])(
    'rejects unsupported policy identifier %s',
    async (policyVersion) => {
      const { service, authorization } = setup();
      await expect(service.approve('org-a', 'admin-a', {
        organizationId: 'org-a',
        confirmationOrganizationId: 'org-a',
        confirmationOrganizationSlug: 'org-a',
        confirmRealDataApproval: true,
        policyVersion,
        agreementEvidenceReference: 'agreement-1',
        allowedDataScopeReference: 'scope-1',
        privacySecurityReadinessReference: 'readiness-1',
        effectiveAt: '2026-11-13T18:00:00.000Z',
        reviewDueAt: '2099-01-01T00:00:00.000Z',
      })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'UNSUPPORTED_REAL_DATA_POLICY_VERSION' }),
      });
      expect(authorization.upsert).not.toHaveBeenCalled();
    },
  );

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

  it('marks all historical decision lineages by version-specific organization digest', async () => {
    const { service, tx, authorization } = setup();
    authorization.findUnique.mockResolvedValueOnce({ decisionId: 'current-decision' });
    const v1Key = Buffer.alloc(32, 7).toString('base64');
    const v2Key = Buffer.alloc(32, 8).toString('base64');
    process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION = 'test-v2';
    process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING = JSON.stringify([
      { version: 'test-v1', key: `base64:${v1Key}` },
      { version: 'test-v2', key: `base64:${v2Key}` },
    ]);
    tx.realDataAuthorizationEvidence.findMany
      .mockResolvedValueOnce([
        { hmacKeyVersion: 'test-v1' },
        { hmacKeyVersion: 'test-v2' },
      ])
      .mockResolvedValueOnce([
        { authorizationDecisionId: 'revision-1-decision' },
        { authorizationDecisionId: 'revision-2-decision' },
      ]);
    tx.realDataAuthorizationEvidence.updateMany.mockResolvedValueOnce({ count: 4 });
    const erasedAt = new Date('2026-11-13T20:00:00Z');
    await expect(service.markWorkspaceErased(tx, 'org-a', erasedAt)).resolves.toEqual({ count: 4 });
    expect(tx.realDataAuthorizationEvidence.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        OR: [
          { hmacKeyVersion: 'test-v1', organizationIdHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
          { hmacKeyVersion: 'test-v2', organizationIdHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
        ],
      },
      select: { authorizationDecisionId: true },
      distinct: ['authorizationDecisionId'],
    });
    expect(tx.realDataAuthorizationEvidence.updateMany).toHaveBeenCalledWith({
      where: {
        authorizationDecisionId: {
          in: ['revision-1-decision', 'revision-2-decision'],
        },
        workspaceErasedAt: null,
      },
      data: { workspaceErasedAt: erasedAt },
    });
  });

  it('finds v1-only history after v2 becomes active without rewriting hashes', async () => {
    const { service, tx, authorization } = setup();
    authorization.findUnique.mockResolvedValueOnce({ decisionId: 'current-decision' });
    process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION = 'test-v2';
    process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING = JSON.stringify([
      { version: 'test-v1', key: `base64:${Buffer.alloc(32, 7).toString('base64')}` },
      { version: 'test-v2', key: `base64:${Buffer.alloc(32, 8).toString('base64')}` },
    ]);
    tx.realDataAuthorizationEvidence.findMany
      .mockResolvedValueOnce([{ hmacKeyVersion: 'test-v1' }])
      .mockResolvedValueOnce([{ authorizationDecisionId: 'v1-only-decision' }]);

    await service.markWorkspaceErased(tx, 'org-a', new Date('2026-11-13T20:00:00Z'));

    expect(tx.realDataAuthorizationEvidence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          authorizationDecisionId: { in: ['v1-only-decision'] },
        }),
      }),
    );
    expect(tx.realDataAuthorizationEvidence.updateMany.mock.calls[0][0].data)
      .toEqual({ workspaceErasedAt: new Date('2026-11-13T20:00:00Z') });
  });

  it('fails closed when a persisted historical key version is unavailable', async () => {
    const { service, tx, authorization } = setup();
    authorization.findUnique.mockResolvedValueOnce({ decisionId: 'current-decision' });
    process.env.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION = 'test-v2';
    process.env.REAL_DATA_EVIDENCE_HMAC_KEYRING = JSON.stringify([
      { version: 'test-v2', key: `base64:${Buffer.alloc(32, 8).toString('base64')}` },
    ]);
    tx.realDataAuthorizationEvidence.findMany.mockResolvedValueOnce([
      { hmacKeyVersion: 'test-v1' },
      { hmacKeyVersion: 'test-v2' },
    ]);

    await expect(
      service.markWorkspaceErased(tx, 'org-a', new Date('2026-11-13T20:00:00Z')),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(tx.realDataAuthorizationEvidence.updateMany).not.toHaveBeenCalled();
  });
});

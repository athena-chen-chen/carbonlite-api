import { ForbiddenException } from '@nestjs/common';
import { AiAuthorizationService } from './ai-authorization.service';
import {
  AI_PROVIDER_OPENAI,
  AI_SCOPE_DOCUMENT_EXTRACTION,
} from './ai-authorization.constants';

function enabledAuthorization(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-a',
    status: 'ENABLED',
    consentVersion: 'consent-v1',
    provider: AI_PROVIDER_OPENAI,
    processingScope: AI_SCOPE_DOCUMENT_EXTRACTION,
    evidenceReference: 'evidence://synthetic-consent',
    authorizedRepresentativeReference: 'customer-representative-ref',
    verifiedById: 'platform-admin-a',
    verifiedAt: new Date('2026-11-01T00:00:00.000Z'),
    effectiveAt: new Date('2026-11-01T00:00:00.000Z'),
    expiresAt: null,
    withdrawnAt: null,
    withdrawalReference: null,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    organization: { isActive: true, customerStatus: 'ACTIVE' },
    ...overrides,
  };
}

function subject(record: unknown) {
  const tx = {
    organizationAiAuthorization: {
      findUnique: jest.fn().mockResolvedValue(record),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    organizationAiAuthorization: {
      findUnique: jest.fn().mockResolvedValue(record),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'org-a',
        isActive: true,
        customerStatus: 'ACTIVE',
      }),
    },
    $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  };
  const auditLog = { log: jest.fn() };
  const realDataAuthorization = {
    lockProcessingApproval: jest.fn().mockResolvedValue(undefined),
    assertEffectiveRealDataApproval: jest.fn().mockResolvedValue({ approvalRevision: 1 }),
  };
  return {
    service: new AiAuthorizationService(
      prisma as never,
      auditLog as never,
      realDataAuthorization as never,
    ),
    prisma,
    tx,
    auditLog,
    realDataAuthorization,
  };
}

const originalRealDataAiFlag = process.env.REAL_DATA_AI_PROCESSING_ENABLED;
const originalConsentVersion = process.env.CARBONLITE_AI_CONSENT_VERSION;

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnvironment('REAL_DATA_AI_PROCESSING_ENABLED', originalRealDataAiFlag);
  restoreEnvironment('CARBONLITE_AI_CONSENT_VERSION', originalConsentVersion);
});

describe('AiAuthorizationService provider gate', () => {
  it.each([
    ['new organization defaults to AI disabled', null],
    ['existing organization without a consent record remains disabled', null],
    ['customer-declined DISABLED election is denied', enabledAuthorization({ status: 'DISABLED' })],
    ['withdrawn authorization is denied', enabledAuthorization({ status: 'WITHDRAWN', withdrawnAt: new Date() })],
    ['expired authorization is denied', enabledAuthorization({ expiresAt: new Date('2026-01-01T00:00:00.000Z') })],
    ['suspended organization is denied', enabledAuthorization({ organization: { isActive: true, customerStatus: 'SUSPENDED' } })],
    ['missing evidence is denied', enabledAuthorization({ evidenceReference: '  ' })],
    ['missing consent version is denied', enabledAuthorization({ consentVersion: '  ' })],
    ['unsupported provider is denied', enabledAuthorization({ provider: 'OTHER_PROVIDER' })],
    ['unsupported scope is denied', enabledAuthorization({ processingScope: 'REPORT_GENERATION' })],
    ['cross-tenant lookup cannot use another organization authorization', null],
  ])('%s', async (_name, record) => {
    const { service, prisma } = subject(record);
    await expect(
      service.assertProviderRequestAllowed(
        _name.startsWith('cross-tenant') ? 'org-b' : 'org-a',
        AI_PROVIDER_OPENAI,
        AI_SCOPE_DOCUMENT_EXTRACTION,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    if (_name.startsWith('cross-tenant')) {
      expect(prisma.organizationAiAuthorization.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: 'org-b' } }),
      );
    }
  });

  it('permits a valid current organization authorization', async () => {
    const authorization = enabledAuthorization();
    const { service } = subject(authorization);
    await expect(
      service.assertProviderRequestAllowed(
        'org-a',
        AI_PROVIDER_OPENAI,
        AI_SCOPE_DOCUMENT_EXTRACTION,
      ),
    ).resolves.toBe(authorization);
  });

  it('keeps synthetic-only AI authorization independent from the real-data runtime gates', async () => {
    delete process.env.REAL_DATA_AI_PROCESSING_ENABLED;
    delete process.env.CARBONLITE_AI_CONSENT_VERSION;
    const authorization = enabledAuthorization({
      authorizedDataMode: 'SYNTHETIC_TEST_ONLY',
      realDataApprovalRevision: null,
    });
    const { service } = subject(authorization);

    await expect(service.assertProviderRequestAllowed(
      'org-a',
      AI_PROVIDER_OPENAI,
      AI_SCOPE_DOCUMENT_EXTRACTION,
      'SYNTHETIC_TEST',
    )).resolves.toBe(authorization);
  });

  it('returns a customer-safe status without evidence or verifier metadata', async () => {
    const { service } = subject(enabledAuthorization());
    const status = await service.getCustomerStatus('org-a');

    expect(status).toMatchObject({
      enabled: true,
      status: 'ENABLED',
      provider: 'OPENAI',
      processingScope: 'DOCUMENT_EXTRACTION',
    });
    expect(status).not.toHaveProperty('evidenceReference');
    expect(status).not.toHaveProperty('authorizedRepresentativeReference');
    expect(status).not.toHaveProperty('verifiedById');
  });

  it('fails closed when the authorization database lookup fails', async () => {
    const { service, prisma } = subject(enabledAuthorization());
    prisma.organizationAiAuthorization.findUnique.mockRejectedValueOnce(
      new Error('synthetic database failure'),
    );
    await expect(
      service.assertProviderRequestAllowed(
        'org-a',
        AI_PROVIDER_OPENAI,
        AI_SCOPE_DOCUMENT_EXTRACTION,
      ),
    ).rejects.toThrow('synthetic database failure');
  });
});

describe('AiAuthorizationService real-data runtime gate', () => {
  function realDataAuthorization(overrides: Record<string, unknown> = {}) {
    return enabledAuthorization({
      consentVersion: 'P0-AI-MATRIX-REAL-DATA-R2',
      authorizedDataMode: 'REAL_CUSTOMER_DATA',
      realDataApprovalRevision: 2,
      ...overrides,
    });
  }

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['malformed uppercase', 'TRUE'],
    ['malformed padded value', ' true '],
  ])('denies when REAL_DATA_AI_PROCESSING_ENABLED is %s', async (_name, value) => {
    if (value === undefined) delete process.env.REAL_DATA_AI_PROCESSING_ENABLED;
    else process.env.REAL_DATA_AI_PROCESSING_ENABLED = value;
    process.env.CARBONLITE_AI_CONSENT_VERSION = 'P0-AI-MATRIX-REAL-DATA-R2';
    const { service, prisma, realDataAuthorization: approval } = subject(
      realDataAuthorization(),
    );

    await expect(service.assertProviderRequestAllowed(
      'org-a',
      AI_PROVIDER_OPENAI,
      AI_SCOPE_DOCUMENT_EXTRACTION,
      'REAL_CUSTOMER_DATA',
    )).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_REAL_DATA_PROCESSING_DISABLED' }),
    });
    expect(prisma.organizationAiAuthorization.findUnique).not.toHaveBeenCalled();
    expect(approval.assertEffectiveRealDataApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('denies when CARBONLITE_AI_CONSENT_VERSION is %s', async (_name, value) => {
    process.env.REAL_DATA_AI_PROCESSING_ENABLED = 'true';
    if (value === undefined) delete process.env.CARBONLITE_AI_CONSENT_VERSION;
    else process.env.CARBONLITE_AI_CONSENT_VERSION = value;
    const { service, prisma, realDataAuthorization: approval } = subject(
      realDataAuthorization(),
    );

    await expect(service.assertProviderRequestAllowed(
      'org-a',
      AI_PROVIDER_OPENAI,
      AI_SCOPE_DOCUMENT_EXTRACTION,
      'REAL_CUSTOMER_DATA',
    )).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_RUNTIME_CONSENT_VERSION_REQUIRED' }),
    });
    expect(prisma.organizationAiAuthorization.findUnique).not.toHaveBeenCalled();
    expect(approval.assertEffectiveRealDataApproval).not.toHaveBeenCalled();
  });

  it('denies when the stored consent version does not exactly match runtime approval', async () => {
    process.env.REAL_DATA_AI_PROCESSING_ENABLED = 'true';
    process.env.CARBONLITE_AI_CONSENT_VERSION = 'P0-AI-MATRIX-REAL-DATA-R2';
    const { service, realDataAuthorization: approval } = subject(realDataAuthorization({
      consentVersion: 'P0-AI-MATRIX-REAL-DATA-R1',
    }));

    await expect(service.assertProviderRequestAllowed(
      'org-a',
      AI_PROVIDER_OPENAI,
      AI_SCOPE_DOCUMENT_EXTRACTION,
      'REAL_CUSTOMER_DATA',
    )).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_RUNTIME_CONSENT_VERSION_MISMATCH' }),
    });
    expect(approval.assertEffectiveRealDataApproval).not.toHaveBeenCalled();
  });

  it('permits real-data AI only when the strict flag and consent version both match', async () => {
    process.env.REAL_DATA_AI_PROCESSING_ENABLED = 'true';
    process.env.CARBONLITE_AI_CONSENT_VERSION = 'P0-AI-MATRIX-REAL-DATA-R2';
    const authorization = realDataAuthorization();
    const { service, prisma, realDataAuthorization: approval } = subject(authorization);

    await expect(service.assertProviderRequestAllowed(
      'org-a',
      AI_PROVIDER_OPENAI,
      AI_SCOPE_DOCUMENT_EXTRACTION,
      'REAL_CUSTOMER_DATA',
    )).resolves.toBe(authorization);
    expect(approval.assertEffectiveRealDataApproval).toHaveBeenCalledWith('org-a', 2, prisma);
  });

  it('still denies a withdrawn authorization after the runtime gates pass', async () => {
    process.env.REAL_DATA_AI_PROCESSING_ENABLED = 'true';
    process.env.CARBONLITE_AI_CONSENT_VERSION = 'P0-AI-MATRIX-REAL-DATA-R2';
    const { service, realDataAuthorization: approval } = subject(realDataAuthorization({
      status: 'WITHDRAWN',
      withdrawnAt: new Date('2026-11-15T23:00:00.000Z'),
    }));

    await expect(service.assertProviderRequestAllowed(
      'org-a',
      AI_PROVIDER_OPENAI,
      AI_SCOPE_DOCUMENT_EXTRACTION,
      'REAL_CUSTOMER_DATA',
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(approval.assertEffectiveRealDataApproval).not.toHaveBeenCalled();
  });

  it('propagates a stale real-data approval revision denial after runtime gates pass', async () => {
    process.env.REAL_DATA_AI_PROCESSING_ENABLED = 'true';
    process.env.CARBONLITE_AI_CONSENT_VERSION = 'P0-AI-MATRIX-REAL-DATA-R2';
    const { service, realDataAuthorization: approval } = subject(realDataAuthorization());
    approval.assertEffectiveRealDataApproval.mockRejectedValueOnce(
      new ForbiddenException({
        statusCode: 403,
        code: 'REAL_DATA_APPROVAL_REVISION_MISMATCH',
        message: 'Real-data authorization revision does not match.',
        error: 'Forbidden',
      }),
    );

    await expect(service.assertProviderRequestAllowed(
      'org-a',
      AI_PROVIDER_OPENAI,
      AI_SCOPE_DOCUMENT_EXTRACTION,
      'REAL_CUSTOMER_DATA',
    )).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'REAL_DATA_APPROVAL_REVISION_MISMATCH' }),
    });
  });

  it('reports real-data AI disabled to customers when runtime gates do not match', async () => {
    process.env.REAL_DATA_AI_PROCESSING_ENABLED = 'true';
    process.env.CARBONLITE_AI_CONSENT_VERSION = 'another-consent-version';
    const { service } = subject(realDataAuthorization());

    await expect(service.getCustomerStatus('org-a')).resolves.toMatchObject({
      enabled: false,
      status: 'ENABLED',
      authorizedDataMode: 'REAL_CUSTOMER_DATA',
      realDataApprovalRevision: 2,
    });
  });
});

describe('AiAuthorizationService administrative records', () => {
  it('records an auditable election without copying consent evidence content into the audit value', async () => {
    const { service, tx, auditLog } = subject(null);
    const saved = enabledAuthorization();
    tx.organizationAiAuthorization.upsert.mockResolvedValue(saved);

    await service.recordDecision('org-a', 'platform-admin-a', {
      status: 'ENABLED',
      consentVersion: 'consent-v1',
      provider: AI_PROVIDER_OPENAI,
      processingScope: AI_SCOPE_DOCUMENT_EXTRACTION,
      evidenceReference: 'evidence://synthetic-consent',
      authorizedRepresentativeReference: 'customer-representative-ref',
      effectiveAt: '2026-11-01T00:00:00.000Z',
    });

    expect(auditLog.log).toHaveBeenCalledTimes(1);
    const auditInput = auditLog.log.mock.calls[0][0];
    expect(auditInput.action).toBe('AI_AUTHORIZATION_RECORDED');
    expect(JSON.stringify(auditInput.newValue)).not.toContain('evidence://synthetic-consent');
    expect(auditInput.newValue).toMatchObject({ evidenceReferencePresent: true });
  });
});

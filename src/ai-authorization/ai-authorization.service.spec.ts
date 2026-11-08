import { ForbiddenException } from '@nestjs/common';
import { AiAuthorizationService } from './ai-authorization.service';
import {
  AI_CONSENT_VERSION_ENV,
  AI_GLOBAL_ACTIVATION_ENV,
  AI_PROVIDER_OPENAI,
  AI_SCOPE_DOCUMENT_EXTRACTION,
} from './ai-authorization.constants';

const originalGlobalGate = process.env[AI_GLOBAL_ACTIVATION_ENV];
const originalConsentVersion = process.env[AI_CONSENT_VERSION_ENV];

beforeEach(() => {
  process.env[AI_GLOBAL_ACTIVATION_ENV] = 'true';
  process.env[AI_CONSENT_VERSION_ENV] = 'consent-v1';
});

afterAll(() => {
  if (originalGlobalGate === undefined) delete process.env[AI_GLOBAL_ACTIVATION_ENV];
  else process.env[AI_GLOBAL_ACTIVATION_ENV] = originalGlobalGate;
  if (originalConsentVersion === undefined) delete process.env[AI_CONSENT_VERSION_ENV];
  else process.env[AI_CONSENT_VERSION_ENV] = originalConsentVersion;
});

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
    organization: { isActive: true, customerStatus: 'PILOT' },
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
      findUnique: jest.fn().mockResolvedValue({ id: 'org-a' }),
    },
    $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  };
  const auditLog = { log: jest.fn() };
  return {
    service: new AiAuthorizationService(prisma as never, auditLog as never),
    prisma,
    tx,
    auditLog,
  };
}

describe('AiAuthorizationService provider gate', () => {
  it.each([
    ['new organization defaults to AI disabled', null],
    ['existing organization without a consent record remains disabled', null],
    ['customer-declined DISABLED election is denied', enabledAuthorization({ status: 'DISABLED' })],
    ['withdrawn authorization is denied', enabledAuthorization({ status: 'WITHDRAWN', withdrawnAt: new Date() })],
    ['expired authorization is denied', enabledAuthorization({ expiresAt: new Date('2026-01-01T00:00:00.000Z') })],
    ['suspended organization is denied', enabledAuthorization({ organization: { isActive: true, customerStatus: 'SUSPENDED' } })],
    ['missing evidence is denied', enabledAuthorization({ evidenceReference: '  ' })],
    ['superseded consent version is denied', enabledAuthorization({ consentVersion: 'consent-v0' })],
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

  it('permits a valid current authorization when the global activation gate is on', async () => {
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

  it('denies every organization when the global production activation gate is off', async () => {
    const { service, prisma } = subject(enabledAuthorization());
    process.env[AI_GLOBAL_ACTIVATION_ENV] = 'false';
    await expect(
      service.assertProviderRequestAllowed(
        'org-a',
        AI_PROVIDER_OPENAI,
        AI_SCOPE_DOCUMENT_EXTRACTION,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.organizationAiAuthorization.findUnique).not.toHaveBeenCalled();
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

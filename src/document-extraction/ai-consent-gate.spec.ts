import { extractionOperationsFixture } from '../../test/helpers/extraction-operations-fixture';
import { ForbiddenException } from '@nestjs/common';
import { AiAuthorizationService } from '../ai-authorization/ai-authorization.service';
import { isOpenAiConfigured, openai } from '../openai/openai.client';
import { DocumentExtractionService } from './document-extraction.service';

jest.mock('../openai/openai.client', () => ({
  isOpenAiConfigured: jest.fn().mockReturnValue(true),
  openai: { responses: { create: jest.fn() } },
}));

const originalRealDataAiFlag = process.env.REAL_DATA_AI_PROCESSING_ENABLED;
const originalConsentVersion = process.env.CARBONLITE_AI_CONSENT_VERSION;

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function subject(
  assertProviderRequestAllowed: jest.Mock,
  overrides: Partial<{
    fileName: string;
    mimeType: string;
    type: string;
    status: string;
    ingestionDataMode: 'SYNTHETIC_TEST' | 'REAL_CUSTOMER_DATA';
  }> = {},
) {
  const document = {
    id: 'doc-1',
    organizationId: 'org-a',
    fileName: 'bill.pdf',
    fileUrl: '/uploads/bill.pdf',
    mimeType: 'application/pdf',
    type: 'PDF',
    status: 'UPLOADED',
    ingestionDataMode: 'SYNTHETIC_TEST',
    ...overrides,
  };
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ active: 1 }]),
    document: {
      findFirst: jest.fn().mockResolvedValue(document),
      update: jest.fn().mockResolvedValue(document),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((work: (client: unknown) => unknown) =>
    work(prisma),
  );
  const storage = {
    exists: jest.fn().mockResolvedValue(true),
    read: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4\nsynthetic fixture\n%%EOF')),
  };
  const quotas = {
    beginExtraction: jest.fn().mockResolvedValue(null),
    finishExtraction: jest.fn().mockResolvedValue(undefined),
  };
  const auditLog = { log: jest.fn() };
  const activityTracking = { track: jest.fn() };
  const operations = extractionOperationsFixture(document);
  const service = new DocumentExtractionService(
    prisma,
    auditLog as never,
    activityTracking as never,
    null as never,
    storage as never,
    quotas as never,
    { assertProviderRequestAllowed } as never,
    // These tests isolate the AI boundary with an effective independent real-data approval.
    { lockProcessingApproval: jest.fn().mockResolvedValue(undefined),
      assertEffectiveRealDataApproval: jest.fn().mockResolvedValue({ approvalRevision: 2 }) } as never,
    operations as never,
  );
  return { service, prisma, storage, quotas, auditLog, activityTracking, document, operations };
}

describe('DocumentExtractionService AI authorization boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isOpenAiConfigured as jest.Mock).mockReturnValue(true);
  });
  afterEach(() => {
    restoreEnvironment('REAL_DATA_AI_PROCESSING_ENABLED', originalRealDataAiFlag);
    restoreEnvironment('CARBONLITE_AI_CONSENT_VERSION', originalConsentVersion);
  });

  it('denies a synthetic PDF before leases, status changes, tracking, or provider calls when AI is not authorized', async () => {
    const authorization = jest
      .fn()
      .mockRejectedValue(new ForbiddenException('AI processing is disabled.'));
    const { service, prisma, quotas, activityTracking } = subject(authorization);

    await expect(service.extract('org-a', 'doc-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(authorization).toHaveBeenCalledTimes(1);
    expect(openai.responses.create).not.toHaveBeenCalled();
    expect(quotas.beginExtraction).not.toHaveBeenCalled();
    expect(quotas.finishExtraction).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(activityTracking.track).not.toHaveBeenCalled();
  });

  it('preserves authorization failure precedence when the provider is not configured', async () => {
    (isOpenAiConfigured as jest.Mock).mockReturnValue(false);
    const authorization = jest
      .fn()
      .mockRejectedValue(new ForbiddenException('AI processing is disabled.'));
    const { service, prisma, storage, quotas, activityTracking } = subject(authorization);

    await expect(service.extract('org-a', 'doc-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(authorization).toHaveBeenCalledTimes(1);
    expect(openai.responses.create).not.toHaveBeenCalled();
    expect(quotas.beginExtraction).not.toHaveBeenCalled();
    expect(storage.read).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(activityTracking.track).not.toHaveBeenCalled();
  });

  it('denies an authorized provider extraction with a controlled 503 before every extraction side effect when the provider is not configured', async () => {
    (isOpenAiConfigured as jest.Mock).mockReturnValue(false);
    const authorization = jest.fn().mockResolvedValue({ status: 'ENABLED' });
    const {
      service,
      prisma,
      storage,
      quotas,
      auditLog,
      activityTracking,
      document,
    } = subject(authorization);

    await expect(service.extract('org-a', 'doc-1')).rejects.toMatchObject({
      status: 503,
      response: {
        statusCode: 503,
        code: 'AI_PROVIDER_NOT_CONFIGURED',
        message: 'AI document extraction is temporarily unavailable.',
        error: 'Service Unavailable',
      },
    });
    expect(authorization).toHaveBeenCalledTimes(1);
    expect(openai.responses.create).not.toHaveBeenCalled();
    expect(quotas.beginExtraction).not.toHaveBeenCalled();
    expect(quotas.finishExtraction).not.toHaveBeenCalled();
    expect(storage.read).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(activityTracking.track).not.toHaveBeenCalled();
    expect(auditLog.log).not.toHaveBeenCalled();
    expect(document.status).toBe('UPLOADED');
  });

  it('denies a real-data PDF with synthetic-only AI consent before extraction side effects', async () => {
    const authorization = jest
      .fn()
      .mockRejectedValue(new ForbiddenException('Real-data AI consent is required.'));
    const { service, prisma, quotas, activityTracking } = subject(authorization, {
      ingestionDataMode: 'REAL_CUSTOMER_DATA',
    });

    await expect(service.extract('org-a', 'doc-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(authorization).toHaveBeenCalledWith(
      'org-a',
      'OPENAI',
      'DOCUMENT_EXTRACTION',
      'REAL_CUSTOMER_DATA',
    );
    expect(openai.responses.create).not.toHaveBeenCalled();
    expect(quotas.beginExtraction).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(activityTracking.track).not.toHaveBeenCalled();
  });

  it('allows a real-data PDF with AI consent bound to the current real-data approval revision to reach the provider', async () => {
    const authorization = jest.fn().mockResolvedValue({
      status: 'ENABLED',
      authorizedDataMode: 'REAL_CUSTOMER_DATA',
      realDataApprovalRevision: 1,
    });
    (openai.responses.create as jest.Mock).mockRejectedValueOnce(
      new Error('synthetic provider failure'),
    );
    const { service, quotas, operations } = subject(authorization, {
      ingestionDataMode: 'REAL_CUSTOMER_DATA',
    });

    await expect(service.extract('org-a', 'doc-1')).rejects.toThrow(
      'Extraction failed. Please try again or upload the file again.',
    );
    expect(authorization).toHaveBeenCalledTimes(2);
    expect(operations.admit).toHaveBeenCalledTimes(1);
    expect(quotas.beginExtraction).not.toHaveBeenCalled();
    expect(openai.responses.create).toHaveBeenCalledTimes(1);
  });

  it('denies a stale real-data AI approval revision before extraction side effects', async () => {
    const authorization = jest
      .fn()
      .mockRejectedValue(new ForbiddenException('Real-data approval revision does not match.'));
    const { service, prisma, quotas } = subject(authorization, {
      ingestionDataMode: 'REAL_CUSTOMER_DATA',
    });

    await expect(service.extract('org-a', 'doc-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(openai.responses.create).not.toHaveBeenCalled();
    expect(quotas.beginExtraction).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
  });

  it('denies a real-data PDF when the global runtime gate is missing before every extraction side effect', async () => {
    delete process.env.REAL_DATA_AI_PROCESSING_ENABLED;
    process.env.CARBONLITE_AI_CONSENT_VERSION = 'P0-AI-MATRIX-REAL-DATA-R2';
    const approval = {
      assertEffectiveRealDataApproval: jest.fn().mockResolvedValue({ approvalRevision: 2 }),
    };
    const aiAuthorization = new AiAuthorizationService(
      {
        organizationAiAuthorization: {
          findUnique: jest.fn().mockResolvedValue({
            organizationId: 'org-a',
            status: 'ENABLED',
            consentVersion: 'P0-AI-MATRIX-REAL-DATA-R2',
            provider: 'OPENAI',
            processingScope: 'DOCUMENT_EXTRACTION',
            evidenceReference: 'evidence://real-data-consent-r2',
            authorizedRepresentativeReference: 'representative-r2',
            verifiedById: 'platform-admin-a',
            verifiedAt: new Date('2026-11-15T23:00:00.000Z'),
            effectiveAt: new Date('2026-11-15T23:00:00.000Z'),
            expiresAt: null,
            withdrawnAt: null,
            authorizedDataMode: 'REAL_CUSTOMER_DATA',
            realDataApprovalRevision: 2,
            organization: { isActive: true, customerStatus: 'ACTIVE' },
          }),
        },
      } as never,
      { log: jest.fn() } as never,
      approval as never,
    );
    const authorization = jest.fn(
      aiAuthorization.assertProviderRequestAllowed.bind(aiAuthorization),
    );
    const {
      service,
      prisma,
      storage,
      quotas,
      auditLog,
      activityTracking,
      document,
    } = subject(authorization, { ingestionDataMode: 'REAL_CUSTOMER_DATA' });

    await expect(service.extract('org-a', 'doc-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_REAL_DATA_PROCESSING_DISABLED' }),
    });
    expect(authorization).toHaveBeenCalledTimes(1);
    expect(approval.assertEffectiveRealDataApproval).not.toHaveBeenCalled();
    expect(openai.responses.create).not.toHaveBeenCalled();
    expect(quotas.beginExtraction).not.toHaveBeenCalled();
    expect(quotas.finishExtraction).not.toHaveBeenCalled();
    expect(storage.read).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(activityTracking.track).not.toHaveBeenCalled();
    expect(auditLog.log).not.toHaveBeenCalled();
    expect(document.status).toBe('UPLOADED');
  });

  it('denies revision-1 real-data AI consent when the effective real-data approval is revision 2 before extraction side effects', async () => {
    process.env.REAL_DATA_AI_PROCESSING_ENABLED = 'true';
    process.env.CARBONLITE_AI_CONSENT_VERSION = 'real-data-consent-r1';
    const realDataAuthorization = {
      assertEffectiveRealDataApproval: jest.fn(
        async (_organizationId: string, expectedRevision: number) => {
          if (expectedRevision !== 2) {
            throw new ForbiddenException({
              statusCode: 403,
              code: 'REAL_DATA_APPROVAL_REVISION_MISMATCH',
              message: 'Real-data authorization revision does not match.',
              error: 'Forbidden',
            });
          }
          return { approvalRevision: 2 };
        },
      ),
    };
    const aiAuthorization = new AiAuthorizationService(
      {
        organizationAiAuthorization: {
          findUnique: jest.fn().mockResolvedValue({
            organizationId: 'org-a',
            status: 'ENABLED',
            consentVersion: 'real-data-consent-r1',
            provider: 'OPENAI',
            processingScope: 'DOCUMENT_EXTRACTION',
            evidenceReference: 'evidence://real-data-consent-r1',
            authorizedRepresentativeReference: 'representative-r1',
            verifiedById: 'platform-admin-a',
            verifiedAt: new Date('2026-11-15T20:00:00.000Z'),
            effectiveAt: new Date('2026-11-15T20:00:00.000Z'),
            expiresAt: null,
            withdrawnAt: null,
            authorizedDataMode: 'REAL_CUSTOMER_DATA',
            realDataApprovalRevision: 1,
            organization: { isActive: true, customerStatus: 'ACTIVE' },
          }),
        },
      } as never,
      { log: jest.fn() } as never,
      realDataAuthorization as never,
    );
    const authorization = jest.fn(
      aiAuthorization.assertProviderRequestAllowed.bind(aiAuthorization),
    );
    const {
      service,
      prisma,
      storage,
      quotas,
      auditLog,
      activityTracking,
      document,
    } = subject(authorization, { ingestionDataMode: 'REAL_CUSTOMER_DATA' });

    await expect(service.extract('org-a', 'doc-1')).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'REAL_DATA_APPROVAL_REVISION_MISMATCH',
      }),
    });
    expect(realDataAuthorization.assertEffectiveRealDataApproval).toHaveBeenCalledWith(
      'org-a',
      1,
      expect.objectContaining({ organizationAiAuthorization: expect.any(Object) }),
    );
    expect(openai.responses.create).not.toHaveBeenCalled();
    expect(quotas.beginExtraction).not.toHaveBeenCalled();
    expect(quotas.finishExtraction).not.toHaveBeenCalled();
    expect(storage.read).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(activityTracking.track).not.toHaveBeenCalled();
    expect(auditLog.log).not.toHaveBeenCalled();
    expect(document.status).toBe('UPLOADED');
  });

  it('keeps supported local JSON extraction independent from OpenAI authorization', async () => {
    (isOpenAiConfigured as jest.Mock).mockReturnValue(false);
    const authorization = jest.fn();
    const { service, quotas, storage, operations } = subject(authorization, {
      fileName: 'activities.json',
      mimeType: 'application/json',
      type: 'OTHER',
    });
    storage.read.mockResolvedValue(Buffer.from('{"activities":[]}'));
    jest.spyOn(service as any, 'extractStructuredJsonDocument').mockResolvedValue({
      documentId: 'doc-1',
      status: 'REVIEW_REQUIRED',
      parsedActivities: [],
    });

    await expect(service.extract('org-a', 'doc-1')).resolves.toMatchObject({
      documentId: 'doc-1',
      status: 'REVIEW_REQUIRED',
    });
    expect(authorization).not.toHaveBeenCalled();
    expect(operations.admit).toHaveBeenCalledTimes(1);
    expect(quotas.beginExtraction).not.toHaveBeenCalled();
    expect(openai.responses.create).not.toHaveBeenCalled();
  });

  it('rechecks authorization immediately before the provider call so withdrawal blocks queued work', async () => {
    const authorization = jest
      .fn()
      .mockResolvedValueOnce({ status: 'ENABLED' })
      .mockRejectedValueOnce(new ForbiddenException('Authorization withdrawn.'));
    const { service, storage } = subject(authorization);
    let releaseRead!: (value: Buffer) => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    storage.read.mockImplementationOnce(
      () => new Promise<Buffer>((resolve) => {
        releaseRead = resolve;
        markReadStarted();
      }),
    );

    const queued = service.extract('org-a', 'doc-1');
    await readStarted;
    expect(authorization).toHaveBeenCalledTimes(1);
    releaseRead(Buffer.from('%PDF-1.4\nsynthetic fixture\n%%EOF'));

    await expect(queued).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(authorization).toHaveBeenCalledTimes(2);
    expect(openai.responses.create).not.toHaveBeenCalled();
  });

  it('reaches a mocked provider failure only after authorization succeeds', async () => {
    const authorization = jest.fn().mockResolvedValue({ status: 'ENABLED' });
    (openai.responses.create as jest.Mock).mockRejectedValueOnce(
      new Error('synthetic provider failure'),
    );
    const { service } = subject(authorization);

    await expect(service.extract('org-a', 'doc-1')).rejects.toThrow(
      'Extraction failed. Please try again or upload the file again.',
    );
    expect(authorization).toHaveBeenCalledTimes(2);
    expect(openai.responses.create).toHaveBeenCalledTimes(1);
    expect(authorization.mock.invocationCallOrder[0]).toBeLessThan(
      (openai.responses.create as jest.Mock).mock.invocationCallOrder[0],
    );
  });
});

import { ForbiddenException } from '@nestjs/common';
import { openai } from '../openai/openai.client';
import { DocumentExtractionService } from './document-extraction.service';

jest.mock('../openai/openai.client', () => ({
  openai: { responses: { create: jest.fn() } },
}));

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
  const service = new DocumentExtractionService(
    prisma,
    auditLog as never,
    activityTracking as never,
    null as never,
    storage as never,
    quotas as never,
    { assertProviderRequestAllowed } as never,
  );
  return { service, prisma, storage, quotas, auditLog, activityTracking, document };
}

describe('DocumentExtractionService AI authorization boundary', () => {
  beforeEach(() => jest.clearAllMocks());

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
    const { service, quotas } = subject(authorization, {
      ingestionDataMode: 'REAL_CUSTOMER_DATA',
    });

    await expect(service.extract('org-a', 'doc-1')).rejects.toThrow(
      'Extraction failed. Please try again or upload the file again.',
    );
    expect(authorization).toHaveBeenCalledTimes(2);
    expect(quotas.beginExtraction).toHaveBeenCalledTimes(1);
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

  it('keeps supported local JSON extraction independent from OpenAI authorization', async () => {
    const authorization = jest.fn();
    const { service, quotas, storage } = subject(authorization, {
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
    expect(quotas.beginExtraction).toHaveBeenCalledTimes(1);
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

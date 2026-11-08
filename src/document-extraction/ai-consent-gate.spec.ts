import { ForbiddenException } from '@nestjs/common';
import { openai } from '../openai/openai.client';
import { DocumentExtractionService } from './document-extraction.service';

jest.mock('../openai/openai.client', () => ({
  openai: { responses: { create: jest.fn() } },
}));

function subject(assertProviderRequestAllowed: jest.Mock) {
  const document = {
    id: 'doc-1',
    organizationId: 'org-a',
    fileName: 'bill.pdf',
    fileUrl: '/uploads/bill.pdf',
    mimeType: 'application/pdf',
    type: 'PDF',
    status: 'UPLOADED',
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
  const service = new DocumentExtractionService(
    prisma,
    { log: jest.fn() } as never,
    { track: jest.fn() } as never,
    null as never,
    storage as never,
    quotas as never,
    { assertProviderRequestAllowed } as never,
  );
  return { service, prisma, storage };
}

describe('DocumentExtractionService AI authorization boundary', () => {
  beforeEach(() => jest.clearAllMocks());

  it('makes zero provider calls when the organization is not authorized', async () => {
    const authorization = jest
      .fn()
      .mockRejectedValue(new ForbiddenException('AI processing is disabled.'));
    const { service, prisma } = subject(authorization);

    await expect(service.extract('org-a', 'doc-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(authorization).toHaveBeenCalledTimes(1);
    expect(openai.responses.create).not.toHaveBeenCalled();
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      data: { status: 'EXTRACTION_FAILED' },
    });
  });

  it('rechecks authorization immediately before the provider call so withdrawal blocks queued work', async () => {
    const authorization = jest
      .fn()
      .mockRejectedValue(new ForbiddenException('Authorization withdrawn.'));
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
    expect(authorization).not.toHaveBeenCalled();
    releaseRead(Buffer.from('%PDF-1.4\nsynthetic fixture\n%%EOF'));

    await expect(queued).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(authorization).toHaveBeenCalledTimes(1);
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
    expect(authorization).toHaveBeenCalledTimes(1);
    expect(openai.responses.create).toHaveBeenCalledTimes(1);
    expect(authorization.mock.invocationCallOrder[0]).toBeLessThan(
      (openai.responses.create as jest.Mock).mock.invocationCallOrder[0],
    );
  });
});

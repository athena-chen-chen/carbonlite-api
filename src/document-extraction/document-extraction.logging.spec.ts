import { extractionOperationsFixture } from '../../test/helpers/extraction-operations-fixture';
import { Logger } from '@nestjs/common';
import { DocumentExtractionService } from './document-extraction.service';
import { openai } from '../openai/openai.client';
import { AuthenticationError } from 'openai';

jest.mock('../openai/openai.client', () => ({ isOpenAiConfigured: jest.fn().mockReturnValue(true), openai: { responses: { create: jest.fn() } } }));
afterEach(() => jest.restoreAllMocks());
it('F16 omits provider credentials, raw message/stack and document content from final extraction logs', async () => {
  const error = new AuthenticationError(
    401,
    {
      type: 'invalid_request_error',
      code: 'invalid_api_key',
      message: 'secret-provider-error secret-document secret-source',
      prompt: 'secret-prompt',
      output: 'secret-output',
    },
    undefined,
    new Headers({
      'x-request-id': 'req_safe_integration',
      authorization: 'secret-auth',
      'x-api-key': 'secret-key',
    }),
  );
  (openai.responses.create as jest.Mock).mockRejectedValue(error);
  const document = { id: 'doc-1', organizationId: 'org-1', fileName: 'bill.pdf', fileUrl: '/uploads/bill.pdf', mimeType: 'application/pdf', type: 'PDF', status: 'UPLOADED' };
  const prisma: any = { document: { findFirst: jest.fn().mockResolvedValue(document), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, $transaction: jest.fn() };
  prisma.$transaction.mockImplementation((callback: (client: unknown) => unknown) => callback(prisma));
  const storage = { exists: jest.fn().mockResolvedValue(true), read: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4\nfixture\n%%EOF')) };
  const authorization = { assertProviderRequestAllowed: jest.fn().mockResolvedValue({}) };
  const quotas = { beginExtraction: jest.fn().mockResolvedValue(null), finishExtraction: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn() };
  const tracker = { track: jest.fn() };
  const service = new DocumentExtractionService(prisma, audit as never, tracker as never, null as never, storage as never, quotas as never, authorization as never, undefined, extractionOperationsFixture(document) as never);
  const logs = ['error', 'warn', 'log'].map(method => jest.spyOn(Logger.prototype, method as 'error').mockImplementation(() => undefined));
  await expect(service.extract('org-1', 'doc-1')).rejects.toThrow('Extraction failed. Please try again or upload the file again.');
  const output = JSON.stringify(logs.map(log => log.mock.calls));
  expect(output).not.toContain('secret-');
  expect(output).toContain('doc-1');
  expect(output).toContain('providerStatus');
  expect(output).toContain('401');
  expect(output).toContain('invalid_request_error');
  expect(output).toContain('invalid_api_key');
  expect(output).toContain('req_safe_integration');
  expect(openai.responses.create).toHaveBeenCalled();
  expect(authorization.assertProviderRequestAllowed).toHaveBeenCalledWith(
    'org-1',
    'OPENAI',
    'DOCUMENT_EXTRACTION',
    undefined,
  );
  expect(prisma.document.updateMany).toHaveBeenCalledWith({
    where: { id: 'doc-1', organizationId: 'org-1' },
    data: { status: 'EXTRACTION_FAILED' },
  });
  expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
    action: 'EXTRACT_DOCUMENT_FAILED', entityId: 'doc-1',
    newValue: { status: 'EXTRACTION_FAILED', reason: 'UNEXPECTED_ERROR' },
  }), prisma);
  expect(tracker.track).toHaveBeenCalledWith(expect.objectContaining({ eventName: 'DOCUMENT_EXTRACT_FAILED' }), prisma);
});

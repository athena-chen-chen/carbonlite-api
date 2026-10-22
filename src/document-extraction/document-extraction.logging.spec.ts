import { Logger } from '@nestjs/common';
import { DocumentExtractionService } from './document-extraction.service';
import { openai } from '../openai/openai.client';

jest.mock('../openai/openai.client', () => ({ openai: { responses: { create: jest.fn() } } }));
jest.mock('fs/promises', () => ({ access: jest.fn(), stat: jest.fn().mockResolvedValue({ size: 30 }), readFile: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4\nfixture\n%%EOF')) }));
afterEach(() => jest.restoreAllMocks());
it('F16 omits provider credentials, raw message/stack and document content from final extraction logs', async () => {
  const error = Object.assign(new Error('secret-provider-error'), { status: 502,
    config: { headers: { Authorization: 'secret-auth', 'X-API-Key': 'secret-key' }, data: { base64: 'secret-document' } },
    response: { data: { extractedText: 'secret-source' } },
  });
  (openai.responses.create as jest.Mock).mockRejectedValue(error);
  const document = { id: 'doc-1', fileName: 'bill.pdf', fileUrl: '/uploads/bill.pdf', mimeType: 'application/pdf', type: 'PDF', status: 'UPLOADED' };
  const prisma: any = { document: { findFirst: jest.fn().mockResolvedValue(document), update: jest.fn() }, $transaction: jest.fn() };
  prisma.$transaction.mockImplementation((callback: (client: unknown) => unknown) => callback(prisma));
  const service = new DocumentExtractionService(prisma, { log: jest.fn() } as never, { track: jest.fn() } as never, null as never);
  const logs = ['error', 'warn', 'log'].map(method => jest.spyOn(Logger.prototype, method as 'error').mockImplementation(() => undefined));
  await expect(service.extract('org-1', 'doc-1')).rejects.toThrow('Extraction failed. Please try again or upload the file again.');
  const output = JSON.stringify(logs.map(log => log.mock.calls));
  expect(output).not.toContain('secret-'); expect(output).toContain('doc-1'); expect(output).toContain('502');
  expect(openai.responses.create).toHaveBeenCalled();
  expect(prisma.document.update).toHaveBeenCalledWith({ where: { id: 'doc-1' }, data: { status: 'EXTRACTION_FAILED' } });
});

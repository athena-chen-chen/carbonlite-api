import { ExecutionContext, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DocumentExtractionController } from './document-extraction.controller';
import { DocumentExtractionService } from './document-extraction.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WorkspaceMutationGuard } from '../auth/guards/workspace-mutation.guard';
import { MAX_EXTRACTED_REVIEW_ROWS } from '../documents/document-resource-policy';

describe('confirmation HTTP collection limit', () => {
  let app: NestExpressApplication;
  const confirmImport = jest.fn().mockResolvedValue({ count: 0, createdIds: [] });
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [DocumentExtractionController],
      providers: [{ provide: DocumentExtractionService, useValue: { confirmImport } }] })
      .overrideGuard(JwtAuthGuard).useValue({ canActivate: (context: ExecutionContext) => {
        context.switchToHttp().getRequest().user = { id: 'actor', organizationId: 'org', role: 'OWNER' }; return true;
      } }).overrideGuard(WorkspaceMutationGuard).useValue({ canActivate: () => true }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    // Isolate the DTO collection cap from Express's smaller default byte limit.
    // This test has no database provider and makes no production parser change.
    app.useBodyParser('json', { limit: '5mb' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });
  afterAll(async () => { await app.close(); });
  it('calls the service at 10,000 and rejects 10,001 before service execution', async () => {
    const rows = Array.from({ length: MAX_EXTRACTED_REVIEW_ROWS }, () => ({
      activityType: 'WATER', quantity: 18, unit: 'm3', recordDate: '2026-03-07',
    }));
    await request(app.getHttpServer()).post('/document-extraction/confirm').send({ documentId: 'source', activities: rows }).expect(201);
    expect(confirmImport).toHaveBeenCalledTimes(1);
    expect(confirmImport.mock.calls[0][2]).toHaveLength(MAX_EXTRACTED_REVIEW_ROWS);
    confirmImport.mockClear();
    await request(app.getHttpServer()).post('/document-extraction/confirm').send({ documentId: 'source', activities: [...rows, rows[0]] }).expect(400);
    expect(confirmImport).not.toHaveBeenCalled();
  });
});

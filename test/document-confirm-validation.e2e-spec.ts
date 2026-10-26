import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { DocumentExtractionService } from '../src/document-extraction/document-extraction.service';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { createE2eApp } from './helpers/e2e-app';
import { authHeader, cleanupTestData, createTestUser, uniqueTestId } from './helpers/factories';

const valid = { activityType: 'GASOLINE', quantity: 350, unit: 'L', recordDate: '2026-03-07', jurisdictionCountry: 'Canada' };

describe('F21 document confirmation HTTP boundary and provenance', () => {
  let app: INestApplication, prisma: PrismaService;
  let organizationId: string, documentId: string, auth: Record<string, string>;
  let confirm: jest.SpyInstance;
  const run = uniqueTestId('f21-confirm');
  beforeAll(async () => {
    const setup = await createE2eApp({ globalFilters: [new GlobalExceptionFilter()] });
    app = setup.app; prisma = setup.prisma;
    const user = await createTestUser(app, { organizationName: run, email: `${run}@carbonlite-e2e.test`, factorProfile: 'reviewed' });
    organizationId = user.user.organizationId; auth = authHeader(user.accessToken);
    const upload = await request(app.getHttpServer()).post('/api/documents/upload').set(auth).field('type', 'SPREADSHEET')
      .attach('file', Buffer.from('activityType,recordDate,quantity,unit\n'), { filename: `${run}.csv`, contentType: 'text/csv' }).expect(201);
    documentId = upload.body.id;
    confirm = jest.spyOn(app.get(DocumentExtractionService), 'confirmImport');
  });
  afterAll(async () => { confirm?.mockRestore(); if (prisma) await cleanupTestData(prisma, run); if (app) await app.close(); });
  const post = (activities: unknown) => request(app.getHttpServer()).post('/api/document-extraction/confirm').set(auth).send({ documentId, activities });
  const state = async () => ({
    document: await prisma.document.findUnique({ where: { id: documentId } }),
    activities: await prisma.activityData.findMany({ where: { organizationId } }),
    staging: await prisma.spreadsheetImportReviewRow.findMany({ where: { organizationId } }),
    extraction: await prisma.documentExtraction.findMany({ where: { organizationId } }),
    audit: await prisma.auditLog.count({ where: { organizationId } }),
    events: await prisma.userActivityEvent.count({ where: { organizationId } }),
    metrics: await prisma.metricResult.count({ where: { organizationId } }),
  });
  it.each([
    [null], ['bad'], [123], [true], [[]], [{}], [valid, null, valid],
    [{ ...valid, quantity: {} }], [{ ...valid, quantity: '350' }],
    [{ ...valid, sourceRow: 'abc' }], [{ ...valid, sourceSheetName: 123 }],
    [{ ...valid, sourceReference: [] }], [{ ...valid, recordDate: 'invalid date' }],
    [{ ...valid, sourcePage: {} }], [{ ...valid, unknown: 'property' }],
  ].map(activities => [activities]))('rejects %j with 400 before service and all writes', async activities => {
    confirm.mockClear(); const before = await state();
    const response = await post(activities).expect(400);
    expect(confirm).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
    expect(response.body.message).toEqual(expect.any(Array));
    expect(JSON.stringify(response.body)).not.toMatch(/TypeError|stack|Prisma|ParsedActivityDto/);
  });
  it('round-trips full lineage and keeps equal row numbers on different sheets distinct', async () => {
    const rows = ['SheetA', 'SheetB'].map((sourceSheetName, index) => ({ ...valid,
      sourceFileName: 'source.xlsx', sourceSheetName, sourceRow: index === 0 ? '2' : 2,
      sourcePage: index === 0 ? '1-2' : 3, sourceReference: `ref-${sourceSheetName}`,
      sourceTextSnippet: `snippet-${sourceSheetName}`, sourceDocumentId: 'untrusted-document',
      documentId: 'untrusted-document', sourceType: 'MANUAL', importBatchId: 'untrusted-row-batch',
      dateEstimated: false, recordYear: 2026, costCad: '12.5', costCurrency: 'CAD',
      matchingStatus: 'MATCHED', calculationStatus: 'CALCULATED', reportTreatment: 'INCLUDED',
      calculatedEmissionsKgCO2e: 999999, matchedFactorId: 'forged', scope: 'TRACKED_METRIC' }));
    confirm.mockClear();
    const response = await post(rows).expect(201);
    expect(response.body.count).toBe(2);
    expect(confirm).toHaveBeenCalledWith(organizationId, documentId,
      rows.map(row => ({ ...row, costCad: 12.5 })), expect.any(String), undefined);
    const saved = await prisma.activityData.findMany({ where: { sourceDocumentId: documentId }, orderBy: { sourceSheetName: 'asc' } });
    expect(saved).toHaveLength(2);
    saved.forEach((row, index) => expect(row).toMatchObject({ sourceDocumentId: documentId,
      sourceFileName: 'source.xlsx', sourceSheetName: rows[index].sourceSheetName, sourceRow: '2',
      sourcePage: String(rows[index].sourcePage), sourceReference: rows[index].sourceReference,
      sourceTextSnippet: rows[index].sourceTextSnippet, sourceType: 'DOCUMENT_AI',
      importBatchId: `document-${documentId}`, calculatedEmissionsKgCO2e: 808.5, scope: 'SCOPE_1' }));
    expect((await post(rows).expect(201)).body.count).toBe(0);
  });
});

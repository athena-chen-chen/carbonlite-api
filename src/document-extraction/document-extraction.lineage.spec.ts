import { DocumentExtractionService } from './document-extraction.service';
import { openai } from '../openai/openai.client';

jest.mock('../openai/openai.client', () => ({ openai: { responses: { create: jest.fn() } } }));
jest.mock('fs/promises', () => ({ access: jest.fn(), stat: jest.fn().mockResolvedValue({ size: 30 }), readFile: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4\nfixture\n%%EOF')) }));

const sourceRows = [
  ['ELECTRICITY', 1250, 'kWh', 'Calgary HQ'],
  ['NATURAL_GAS', 8.5, 'GJ', 'Calgary HQ'],
  ['GASOLINE', 350, 'L', 'Vancouver Fleet'],
  ['HOTEL', 3, 'nights', 'Toronto Sales Trip'],
  ['AIR_TRAVEL', 4280, 'km', 'Corporate Travel'],
].map(([activityType, quantity, unit, facilityName]) => ({ activityType, quantity, unit, facilityName, recordDate: '2026-02-01', jurisdictionCountry: 'Canada', jurisdictionRegion: 'Alberta' }));

describe('document facility and optional cost lineage', () => {
  const service = new DocumentExtractionService(null as never, null as never, null as never, null as never);
  it.each([undefined, null, '', '  '])('keeps missing cost %p null at Confirm normalization', (costCad) => {
    expect((service as any).normalizeActivityForImport({ ...sourceRows[0], costCad }).costCad).toBeNull();
  });
  it.each([0, 12.34, 214.55, 64, 720])('preserves supplied cost %p', (costCad) => {
    expect((service as any).normalizeActivityForImport({ ...sourceRows[0], costCad }).costCad).toBe(costCad);
    expect((service as any).addConfidence({ ...sourceRows[0], costCad }).costCad).toBe(costCad);
  });
  it('maps Location Name into the established facilityName field', () => {
    const row = { ...sourceRows[0], facilityName: undefined, 'Location Name': 'Calgary HQ' };
    expect((service as any).normalizeActivityForImport(row).facilityName).toBe('Calgary HQ');
    expect((service as any).normalizeActivityForExtraction(row, 'operations.xlsx').facilityName).toBe('Calgary HQ');
  });
  it('persists all five free-text facilities and missing costs through Confirm without facility entities', async () => {
    const created: any[] = [];
    const document = { id: 'doc', fileName: 'operations.xlsx', fileUrl: '/uploads/operations.xlsx' };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'doc' }]),
      spreadsheetImportReviewRow: { findMany: jest.fn().mockResolvedValue([]) },
      activityData: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn(async ({ data }) => { created.push(data); return { id: `row-${created.length}` }; }) },
      document: { update: jest.fn(), findFirst: jest.fn().mockResolvedValue(document) },
    };
    const prisma = { document: { findFirst: jest.fn().mockResolvedValue(document) }, $transaction: jest.fn(async (fn) => fn(tx)) };
    const subject = new DocumentExtractionService(prisma as never, { log: jest.fn() } as never, { track: jest.fn() } as never, { prepareCreate: jest.fn(async (_client, data) => ({ ...data, matchingStatus: 'MATCHED', calculationStatus: 'CALCULATED', reportTreatment: 'INCLUDED' })), fields: jest.fn() } as never);
    const result = await subject.confirmImport('org', 'doc', sourceRows);
    expect(result.count).toBe(5);
    expect(created.map(({ activityType, facilityName, costCad }) => [activityType, facilityName, costCad])).toEqual(sourceRows.map((row) => [row.activityType, row.facilityName, null]));
    expect(created.every((row) => row.facilityId == null)).toBe(true);
  });
  it('requests facility and explicit optional cost fields in PDF extraction and retains them in review rows', async () => {
    const document = { id: 'doc', fileName: 'operations.pdf', fileUrl: '/uploads/operations.pdf', mimeType: 'application/pdf' };
    const prisma = { $transaction: jest.fn(), document: { findFirst: jest.fn().mockResolvedValue(document), update: jest.fn() } };
    prisma.$transaction.mockImplementation(callback => callback(prisma));
    const subject = new DocumentExtractionService(prisma as never, { log: jest.fn() } as never, { track: jest.fn() } as never, { prepareCreate: jest.fn(async (_client, data) => ({ ...data, matchingStatus: 'MATCHED', calculationStatus: 'CALCULATED', reportTreatment: 'INCLUDED' })), fields: jest.fn() } as never);
    jest.spyOn(subject as any, 'saveExtractionResult').mockResolvedValue(undefined);
    (openai.responses.create as jest.Mock).mockResolvedValue({ output_text: JSON.stringify({ activities: sourceRows }), status: 'completed' });
    const result = await subject.extract('org', 'doc');
    const request = (openai.responses.create as jest.Mock).mock.calls.at(-1)[0];
    const schema = request.text.format.schema.properties.activities.items;
    expect(schema.required).toEqual(expect.arrayContaining(['facilityName', 'costCad', 'costCurrency']));
    expect(schema.properties.facilityName).toBeDefined();
    expect(result.parsedActivities.map((row) => [row.facilityName.value, row.costCad])).toEqual(sourceRows.map((row) => [row.facilityName, null]));
  });
});

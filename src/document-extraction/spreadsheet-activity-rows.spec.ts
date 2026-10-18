import * as XLSX from 'xlsx';
import { parseSpreadsheetActivityRows } from './spreadsheet-activity-rows';
import { DocumentExtractionService } from './document-extraction.service';
import { openai } from '../openai/openai.client';
import { access, readFile } from 'fs/promises';

jest.mock('../openai/openai.client', () => ({ openai: { responses: { create: jest.fn() } } }));
jest.mock('fs/promises', () => ({ access: jest.fn(), readFile: jest.fn() }));

function workbook(rows: unknown[][]) {
  const w = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet(rows), 'Operations');
  return XLSX.write(w, { type: 'buffer', bookType: 'xlsx' });
}

describe('Uploaded tabular workbook extraction', () => {
  const buffer = workbook([
    ['Service Date', 'Record Category', 'Consumption', 'UOM', 'Region', 'Location Name', 'Original Document', 'Cost CAD'],
    [46058, 'Gasoline', 350, 'L', 'British Columbia', 'Fleet site', 'fuel.csv', 0],
    [46059, 'Electricity', 760, 'kWh', '', 'Warehouse', 'missing-region.csv'],
    [46060, 'Gasoline', 'approx 500', 'L', 'Alberta', 'Fleet site', 'invalid.csv'],
    [46061, 'Office Supplies', 25, 'boxes', 'Alberta', 'Office', 'unknown.csv'],
    ['TOTAL', '', 1135, '', '', '', 'subtotal'],
  ]);

  beforeEach(() => jest.clearAllMocks());

  it('preserves every activity cell and physical row, including invalid rows, without inferring missing context', () => {
    const rows = parseSpreadsheetActivityRows(buffer);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ activityType: 'Gasoline', recordDate: '2026-02-05', quantity: 350, unit: 'L', jurisdictionRegion: 'British Columbia', sourceRow: 2, sourceSheetName: 'Operations', costCad: 0 });
    expect(rows[1].jurisdictionRegion).toBeNull();
    expect(rows[1].costCad).toBeNull();
    expect(rows[2]).toMatchObject({ quantity: null, rawQuantity: 'approx 500', sourceRow: 4 });
    expect(rows[3]).toMatchObject({ activityType: 'Office Supplies', unit: 'boxes' });
  });

  it('routes the actual extract service to local parsing and durable review storage, never the provider', async () => {
    const document = { id: 'document', organizationId: 'org', fileName: 'operations (1).xlsx', fileUrl: '/uploads/workbook', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', status: 'UPLOADED' };
    const prisma = { document: { findFirst: jest.fn().mockResolvedValue(document), update: jest.fn().mockResolvedValue(document) }, documentExtraction: { upsert: jest.fn().mockResolvedValue({}) } };
    const audit = { log: jest.fn() };
    const tracking = { track: jest.fn() };
    (access as jest.Mock).mockResolvedValue(undefined);
    (readFile as jest.Mock).mockResolvedValue(buffer);
    const service = new DocumentExtractionService(prisma as never, audit as never, tracking as never, null as never);
    const result = await service.extract('org', 'document', 'actor');
    expect(openai.responses.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'REVIEW_REQUIRED', sourceRowCount: 4, extractedRowCount: 4, possibleMissingRows: false });
    expect(result.parsedActivities[0]).toMatchObject({ activityType: { value: 'GASOLINE' }, quantity: { value: 350 }, sourceRow: 2, costCad: 0 });
    expect(result.parsedActivities[1].jurisdictionRegion.value).toBeNull();
    expect(result.parsedActivities[2].quantity.value).toBeNull();
    expect(prisma.documentExtraction.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ organizationId: 'org', extractedRowCount: 4 }) }));
  });

  it('rejects unrecognized tables instead of silently returning model-selected rows', () => {
    expect(() => parseSpreadsheetActivityRows(workbook([['Unmapped'], ['data']]))).toThrow(/column mapping/);
  });
});

describe('Workbook re-extraction identity compatibility', () => {
  function subject(existing: any[] = [], extractedRows: any[] = []) {
    const persisted = [...existing];
    const tx = {
      spreadsheetImportReviewRow: { findMany: jest.fn().mockResolvedValue([]) },
      activityData: {
        findMany: jest.fn(async () => persisted),
        create: jest.fn(async ({ data }) => { const row = { ...data, id: `new-${persisted.length}` }; persisted.push(row); return row; }),
      },
      document: { update: jest.fn() },
    };
    const prisma = { document: { findFirst: jest.fn().mockResolvedValue({ id: 'doc', fileName: 'operations.xlsx', extractions: [{ extractedRows }] }) }, $transaction: jest.fn(async fn => fn(tx)) };
    return { service: new DocumentExtractionService(prisma as never, { log: jest.fn() } as never, { track: jest.fn() } as never, { prepareCreate: jest.fn(async (_client, data) => data) } as never), updateDocument: tx.document.update };
  }
  const row = { activityType: 'ELECTRICITY', recordDate: '2026-01-15', quantity: 1250, unit: 'kWh', jurisdictionCountry: 'Canada', jurisdictionRegion: 'Alberta', sourceReference: 'electricity.csv' };

  it('keeps legacy rowless imports deduplicated when local extraction adds physical row metadata', async () => {
    const { service } = subject([{ ...row, recordDate: new Date(row.recordDate), sourceRow: null }]);
    const request = [{ ...row, sourceRow: 2 }, { ...row, activityType: 'GASOLINE', quantity: 350, unit: 'L', sourceReference: 'fuel.csv', sourceRow: 3 }];
    expect((await service.confirmImport('org', 'doc', request)).count).toBe(1);
    expect((await service.confirmImport('org', 'doc', request)).count).toBe(0);
  });

  it('still preserves separate physical rows whose activity values happen to be equal', async () => {
    const { service } = subject();
    const request = [{ ...row, sourceRow: 2 }, { ...row, sourceRow: 3 }];
    expect((await service.confirmImport('org', 'doc', request)).count).toBe(2);
    expect((await service.confirmImport('org', 'doc', request)).count).toBe(0);
  });
  it('keeps uploaded partial sources reviewable until every extracted row has been imported', async () => {
    const ready = { ...row, sourceRow: 2 };
    const unresolved = { ...row, sourceRow: 3, quantity: null };
    const { service, updateDocument } = subject([], [ready, unresolved]);
    expect((await service.confirmImport('org', 'doc', [ready])).count).toBe(1);
    expect(updateDocument).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'REVIEW_REQUIRED', importedAt: null }) }));
    expect((await service.confirmImport('org', 'doc', [{ ...unresolved, quantity: 50 }])).count).toBe(1);
    expect(updateDocument).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'IMPORTED' }) }));
  });

});

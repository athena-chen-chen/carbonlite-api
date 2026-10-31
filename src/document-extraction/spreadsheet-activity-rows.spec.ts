import * as XLSX from 'xlsx';
import { parseSpreadsheetActivityRows } from './spreadsheet-activity-rows';
import { DocumentExtractionService } from './document-extraction.service';
import { openai } from '../openai/openai.client';

jest.mock('../openai/openai.client', () => ({ openai: { responses: { create: jest.fn() } } }));

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
    const prisma = { $transaction: jest.fn(), document: { findFirst: jest.fn().mockResolvedValue(document), update: jest.fn().mockResolvedValue(document) }, documentExtraction: { upsert: jest.fn().mockResolvedValue({}) } };
    prisma.$transaction.mockImplementation(callback => callback(prisma));
    const audit = { log: jest.fn() };
    const tracking = { track: jest.fn() };
    const storage = { exists: jest.fn().mockResolvedValue(true), read: jest.fn().mockResolvedValue(buffer) };
    const service = new DocumentExtractionService(prisma as never, audit as never, tracking as never, null as never, storage as never);
    const result = await service.extract('org', 'document', 'actor');
    expect(openai.responses.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'REVIEW_REQUIRED', sourceRowCount: 4, extractedRowCount: 4, possibleMissingRows: false });
    expect(result.parsedActivities[0]).toMatchObject({ activityType: { value: 'GASOLINE' }, quantity: { value: 350 }, sourceRow: 2, costCad: 0 });
    expect(result.parsedActivities[1].jurisdictionRegion.value).toBeNull();
    expect(result.parsedActivities[2].quantity.value).toBeNull();
    expect(prisma.documentExtraction.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ organizationId: 'org', extractedRowCount: 4 }) }));
    expect(storage.read).toHaveBeenCalledWith('workbook');
  });

  it('rejects unrecognized tables instead of silently returning model-selected rows', () => {
    expect(() => parseSpreadsheetActivityRows(workbook([['Unmapped'], ['data']]))).toThrow(/column mapping/);
  });

  it('derives Hotel room-night only when both Rooms and Nights are positive', () => {
    const rows = parseSpreadsheetActivityRows(workbook([
      ['Record Category', 'Rooms', 'Nights', 'Date', 'Country'],
      ['Hotel', 2, 3, '2026-04-01', 'Canada'],
      ['Hotel', null, 3, '2026-04-02', 'Canada'],
      ['Hotel', 2, null, '2026-04-03', 'Canada'],
      ['Hotel', 0, 3, '2026-04-04', 'Canada'],
    ]));
    expect(rows[0]).toMatchObject({
      quantity: 6,
      unit: 'room-night',
      hotelActivityBasis: { rooms: 2, nights: 3, roomNights: 6 },
      rawSourceRow: { Rooms: 2, Nights: 3 },
    });
    expect(rows[1]).toMatchObject({ quantity: 3, unit: 'nights' });
    expect(rows[2]).toMatchObject({ quantity: null, unit: '' });
    expect(rows[3]).toMatchObject({ quantity: null, unit: '' });
  });

  it('derives Air Travel passenger-km from complete route semantics and preserves source cells', () => {
    const rows = parseSpreadsheetActivityRows(workbook([
      ['Activity', 'Origin Airport', 'Destination Airport', 'Passengers', 'Trip Type', 'Date'],
      ['Air Travel', 'YYC', 'YYZ', 1, 'ROUND_TRIP', '2026-04-01'],
      ['Air Travel', 'YYC', 'YYZ', null, 'ROUND_TRIP', '2026-04-02'],
    ]));
    expect(rows[0]).toMatchObject({
      unit: 'passenger-km',
      activityMetadata: { schemaVersion: 1, type: 'AIR_TRAVEL', originAirport: 'YYC', destinationAirport: 'YYZ', passengerCount: 1, tripType: 'ROUND_TRIP' },
      rawSourceRow: { 'Origin Airport': 'YYC', 'Destination Airport': 'YYZ', Passengers: 1, 'Trip Type': 'ROUND_TRIP' },
    });
    expect(rows[0].quantity).toBeCloseTo(5377.3586266, 6);
    expect(rows[1]).toMatchObject({ quantity: null, unit: '' });
  });
});

describe('Workbook re-extraction identity compatibility', () => {
  function subject(existing: any[] = [], extractedRows: any[] = []) {
    const persisted = [...existing];
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'doc' }]),
      spreadsheetImportReviewRow: { findMany: jest.fn().mockResolvedValue([]) },
      activityData: {
        findMany: jest.fn(async () => persisted),
        create: jest.fn(async ({ data }) => { const row = { ...data, id: `new-${persisted.length}` }; persisted.push(row); return row; }),
      },
      document: { update: jest.fn(), findFirst: jest.fn().mockResolvedValue({ id: 'doc', fileName: 'operations.xlsx', extractions: [{ extractedRows }] }) },
    };
    const prisma = { document: { findFirst: jest.fn().mockResolvedValue({ id: 'doc', fileName: 'operations.xlsx', extractions: [{ extractedRows }] }) }, $transaction: jest.fn(async fn => fn(tx)) };
    return { service: new DocumentExtractionService(prisma as never, { log: jest.fn() } as never, { track: jest.fn() } as never, { prepareCreate: jest.fn(async (_client, data) => ({ ...data, matchingStatus: 'MATCHED', calculationStatus: 'CALCULATED', reportTreatment: 'INCLUDED' })) } as never), updateDocument: tx.document.update };
  }
  const row = { activityType: 'ELECTRICITY', recordDate: '2026-01-15', quantity: 1250, unit: 'kWh', jurisdictionCountry: 'Canada', jurisdictionRegion: 'Alberta', sourceReference: 'electricity.csv' };

  it('keeps legacy rowless imports deduplicated when local extraction adds physical row metadata', async () => {
    const { service } = subject([{ ...row, recordDate: new Date(row.recordDate), sourceRow: null }]);
    const request = [{ ...row, sourceRow: 2 }, { ...row, activityType: 'GASOLINE', quantity: 350, unit: 'L', sourceReference: 'fuel.csv', sourceRow: 3 }];
    expect((await service.confirmImport('org', 'doc', request)).count).toBe(1);
    expect((await service.confirmImport('org', 'doc', request)).count).toBe(0);
  });

  it.each([false, true])('retains legacy row-only retries when one side omits sheet metadata (%s)', async existingHasSheet => {
    const { service } = subject([{ ...row, sourceRow: '2', sourceSheetName: existingHasSheet ? 'Operations' : null, recordDate: new Date(row.recordDate) }]);
    const request = [{ ...row, sourceRow: 2, sourceSheetName: existingHasSheet ? undefined : 'Operations' }];
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

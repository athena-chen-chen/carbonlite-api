import * as XLSX from 'xlsx';
import { parseSpreadsheetActivityRows } from './spreadsheet-activity-rows';
import { MAX_SPREADSHEET_CELLS, MAX_SPREADSHEET_COLUMNS, MAX_SPREADSHEET_ROWS, MAX_SPREADSHEET_SHEETS } from '../documents/document-resource-policy';
function buffer(sheet: XLSX.WorkSheet, sheets = 1, bookType: 'xlsx' | 'biff8' = 'xlsx') {
  const book = XLSX.utils.book_new();
  for (let i = 0; i < sheets; i++) XLSX.utils.book_append_sheet(book, sheet, `Sheet${i}`);
  return XLSX.write(book, { type: 'buffer', bookType, compression: true });
}
const normal = () => XLSX.utils.aoa_to_sheet([['activityType', 'quantity', 'unit', 'recordDate'], ['DIESEL', 10, 'L', '2026-03-07']]);
it.each(['xlsx', 'biff8'] as const)('preserves normal %s intake with bounded parser options', type => {
  expect(parseSpreadsheetActivityRows(buffer(normal(), 1, type))).toEqual([expect.objectContaining({ activityType: 'DIESEL', quantity: 10, unit: 'L', sourceRow: 2 })]);
});
it('rejects malformed containers and too many worksheets', () => {
  expect(() => parseSpreadsheetActivityRows(Buffer.from('PK\x03\x04invalid zip'))).toThrow('Unable to read');
  expect(() => parseSpreadsheetActivityRows(buffer(normal(), MAX_SPREADSHEET_SHEETS + 1))).toThrow('worksheets');
});
it.each([
  [MAX_SPREADSHEET_ROWS + 1, 4], [2, MAX_SPREADSHEET_COLUMNS + 1],
  [Math.ceil(MAX_SPREADSHEET_CELLS / 100) + 1, 100],
])('rejects sparse worksheet dimensions %s x %s before grid conversion', (rows, columns) => {
  const sheet = normal();
  sheet[XLSX.utils.encode_cell({ r: rows - 1, c: columns - 1 })] = { t: 'n', v: 1 };
  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows - 1, c: columns - 1 } });
  expect(() => parseSpreadsheetActivityRows(buffer(sheet))).toThrow('processing limit');
});
it('does not evaluate formulas and preserves the established cached-value behavior', () => {
  const sheet = normal(); sheet.B2 = { t: 'n', v: 10, f: '5+5' };
  expect(parseSpreadsheetActivityRows(buffer(sheet))[0].quantity).toBe(10);
});

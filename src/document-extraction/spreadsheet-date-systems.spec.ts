import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { parseSpreadsheetActivityRows } from './spreadsheet-activity-rows';

const root = join(__dirname, '../..', 'test/fixtures/xlsx-date-systems');
const expected = JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8'));
const bytes = (system: string) => readFileSync(join(root, `dates-${system}.xlsx`));

describe('XLSX record dates under both workbook date systems', () => {
  it.each(['1900', '1904'])('decodes real %s workbook rows against independent calendar expectations', system => {
    const workbook = XLSX.read(bytes(system), { type: 'buffer', cellDates: false });
    expect(workbook.Workbook?.WBProps?.date1904).toBe(system === '1904');
    const serial = workbook.Sheets.Dates.B2.v;
    expect(serial).toBe(system === '1904' ? 44575 : 46037);
    expect(workbook.Sheets.Dates.B2.t).toBe('n');
    expect(workbook.Sheets.Dates.B2.w).toContain('2026-01-15');
    expect(workbook.Sheets.Dates.B9.f).toBe('DATE(2026,1,15)');
    const rows = parseSpreadsheetActivityRows(bytes(system));
    expect(rows).toHaveLength(expected.length);
    expect(rows.map(row => Object.fromEntries(Object.keys(expected[0]).map(key => [key, row[key as keyof typeof row]]))))
      .toEqual(expected);
    // Date year remains identical before the downstream factor-selection layer.
    expect(rows.map(row => row.recordDate.slice(0, 4))).toEqual(expected.map((row: { recordDate: string }) => row.recordDate.slice(0, 4)));
  });
  it('uses distinct serials for equal dates and preserves date-based fallback identity inputs', () => {
    const oldBook = XLSX.read(bytes('1900'), { type: 'buffer', cellDates: false });
    const newBook = XLSX.read(bytes('1904'), { type: 'buffer', cellDates: false });
    expect(Number(oldBook.Sheets.Dates.B2.v) - Number(newBook.Sheets.Dates.B2.v)).toBe(1462);
    const identityFields = (row: ReturnType<typeof parseSpreadsheetActivityRows>[number]) =>
      [row.sourceReference, row.activityType, row.recordDate, row.quantity, row.unit];
    expect(parseSpreadsheetActivityRows(bytes('1900')).map(identityFields))
      .toEqual(parseSpreadsheetActivityRows(bytes('1904')).map(identityFields));
  });
  it('retains raw numeric values and cached formula results rather than localized display dates', () => {
    const rows = parseSpreadsheetActivityRows(bytes('1904'));
    expect(rows.find(row => row.sourceReference === 'modern')).toMatchObject({ rawRecordDate: 44575, recordDate: '2026-01-15' });
    expect(rows.find(row => row.sourceReference === 'text')).toMatchObject({ rawRecordDate: '2026-01-15', recordDate: '2026-01-15' });
    expect(rows.find(row => row.sourceReference === 'noon')?.recordDate).toBe('2026-10-22');
    expect(rows.find(row => row.sourceReference === 'cached-formula')?.recordDate).toBe('2026-01-15');
  });
});

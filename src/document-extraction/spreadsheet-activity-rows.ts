import { assertDocumentSize, MAX_SPREADSHEET_CELLS, MAX_SPREADSHEET_COLUMNS, MAX_SPREADSHEET_ROWS, MAX_SPREADSHEET_SHEETS } from '../documents/document-resource-policy';
import { BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';

const key = (value: unknown) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases = {
  activityType: ['activitytype', 'recordcategory', 'type', 'activity', 'category'],
  recordDate: ['recorddate', 'servicedate', 'activitydate', 'reportingdate', 'date'],
  quantity: ['quantity', 'consumption', 'qty', 'amount', 'usage'],
  unit: ['unit', 'units', 'uom', 'measurement'],
  jurisdictionCountry: ['jurisdictioncountry', 'country'],
  jurisdictionRegion: ['jurisdictionregion', 'province', 'jurisdiction', 'region', 'state', 'stateprovince', 'facilityprovince'],
  facilityName: ['facilityname', 'facility', 'site', 'sitename', 'location', 'locationname', 'branch', 'factory'],
  sourceReference: ['sourcereference', 'originaldocument', 'reference', 'documentreference'],
  costCad: ['costcad', 'amountcad', 'cost'],
  costCurrency: ['costcurrency', 'currency'],
  notes: ['notes'],
} as const;

/** Same tabular intake contract as browser spreadsheet import: first worksheet,
 * header aliases and exact cells. Never ask a language model to choose rows. */
export function inspectSpreadsheetContainer(buffer: Buffer) {
  assertDocumentSize(buffer.length);
  let workbook: XLSX.WorkBook;
  try { workbook = XLSX.read(buffer, { type: 'buffer', bookSheets: true }); }
  catch { throw new BadRequestException('Unable to read spreadsheet. Please check the workbook format.'); }
  if (!workbook.SheetNames?.length) throw new BadRequestException('Spreadsheet contains no worksheets.');
  if (workbook.SheetNames.length > MAX_SPREADSHEET_SHEETS) throw new BadRequestException('File processing limit exceeded: too many worksheets.');
  return workbook.SheetNames;
}

export function parseSpreadsheetActivityRows(buffer: Buffer) {
  const sheetNames = inspectSpreadsheetContainer(buffer);
  let workbook: XLSX.WorkBook;
  try { workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, sheetRows: MAX_SPREADSHEET_ROWS + 1, sheets: [sheetNames[0]], cellFormula: false, cellHTML: false, cellStyles: false }); }
  catch { throw new BadRequestException('Unable to read spreadsheet. Please check the workbook format.'); }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  const reference = sheet?.['!fullref'] ?? sheet?.['!ref'];
  if (reference) {
    const range = XLSX.utils.decode_range(reference);
    const rows = range.e.r + 1, columns = range.e.c + 1;
    if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || columns < 1 ||
        rows > MAX_SPREADSHEET_ROWS || columns > MAX_SPREADSHEET_COLUMNS || rows * columns > MAX_SPREADSHEET_CELLS) {
      throw new BadRequestException('File processing limit exceeded: spreadsheet row, column or cell boundary exceeded.');
    }
  }
  if (Object.keys(sheet ?? {}).length > MAX_SPREADSHEET_CELLS + 10) throw new BadRequestException('File processing limit exceeded: too many cells.');
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: true });
  const headerIndex = grid.findIndex(row => {
    const headers = row.map(key);
    return aliases.activityType.some(a => headers.includes(a)) && aliases.quantity.some(a => headers.includes(a));
  });
  if (headerIndex < 0) throw new BadRequestException('No activity/quantity table found. Use spreadsheet import to review the column mapping.');
  const headers = grid[headerIndex].map(key);
  const read = (row: unknown[], field: keyof typeof aliases) => {
    for (const alias of aliases[field]) {
      const index = headers.indexOf(alias);
      if (index >= 0 && row[index] !== null && row[index] !== undefined && row[index] !== '') return row[index];
    }
    return null;
  };
  const dateOnly = (value: unknown) => {
    if (typeof value === 'number') {
      const d = XLSX.SSF.parse_date_code(value, { date1904: !!workbook.Workbook?.WBProps?.date1904 });
      return d ? `${String(d.y).padStart(4, '0')}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : '';
    }
    return String(value ?? '').trim();
  };
  const numberOrNull = (value: unknown) => {
    if (value === null || value === '') return null;
    const n = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : null;
  };
  return grid.slice(headerIndex + 1).flatMap((row, index) => {
    if (row.every(value => value === null || value === '')) return [];
    const activityType = read(row, 'activityType');
    const rawDate = read(row, 'recordDate');
    // A subtotal has no activity, and is not an activity with invalid fields.
    // Keep unknown activities, missing values and nonnumeric quantities for review.
    if (!activityType && /^(total|subtotal|grand total)$/i.test(String(rawDate ?? '').trim())) return [];
    const rawQuantity = read(row, 'quantity');
    const quantity = numberOrNull(rawQuantity);
    const costCad = numberOrNull(read(row, 'costCad'));
    return [{
      activityType: String(activityType ?? ''), recordDate: dateOnly(rawDate),
      quantity, unit: String(read(row, 'unit') ?? ''),
      jurisdictionCountry: String(read(row, 'jurisdictionCountry') ?? 'Canada'),
      jurisdictionRegion: read(row, 'jurisdictionRegion'), facilityName: read(row, 'facilityName'),
      sourceReference: read(row, 'sourceReference'), notes: read(row, 'notes'),
      costCad, costCurrency: read(row, 'costCurrency') ?? (costCad === null ? null : 'CAD'),
      sourceRow: index + headerIndex + 2, sourceSheetName: sheetName,
      rawQuantity, rawRecordDate: rawDate, rawActivityType: activityType,
      rawSourceRow: Object.fromEntries(grid[headerIndex].map((header, col) => [String(header), row[col] ?? null])),
    }];
  });
}

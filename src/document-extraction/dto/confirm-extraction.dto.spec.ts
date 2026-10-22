import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ConfirmExtractionDto } from './confirm-extraction.dto';
import { MAX_EXTRACTED_REVIEW_ROWS } from '../../documents/document-resource-policy';

const row = { activityType: 'DIESEL', recordDate: '2026-03-07', quantity: 240, unit: 'kg' };
const validate = (activities: unknown, extra = {}) => new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })
  .transform({ documentId: 'source', activities, ...extra }, { type: 'body', metatype: ConfirmExtractionDto });

describe('confirmation nested DTO with production ValidationPipe options', () => {
  it.each([null, 'bad', 123, true, [], {}, [row]])('rejects malformed element %j', async value => {
    await expect(validate([value])).rejects.toBeInstanceOf(BadRequestException);
  });
  it.each([null, {}, 'rows', 123])('rejects non-array collection %j', async value => {
    await expect(validate(value)).rejects.toBeInstanceOf(BadRequestException);
  });
  it.each([
    { quantity: {} }, { quantity: '240' }, { quantity: true }, { quantity: NaN }, { quantity: Infinity },
    { recordDate: 'bad date' }, { recordDate: 20260307 }, { recordDate: null },
    { activityType: [] }, { unit: {} }, { sourceRow: 'abc' }, { sourceRow: -1 }, { sourceRow: 2.5 },
    { sourceRow: true }, { sourceRow: {} }, { sourceRow: Number.MAX_SAFE_INTEGER + 1 },
    { sourcePage: {} }, { sourcePage: -1 }, { sourcePage: true },
    { sourceSheetName: 123 }, { sourceReference: [] }, { sourceTextSnippet: {} },
    { costCad: true }, { costCad: {} }, { costCad: 'abc' }, { dateEstimated: 'true' },
    { jurisdictionCountry: [] }, { jurisdictionRegion: 1 }, { facility: {} },
    { matchingStatus: {} }, { calculatedEmissionsKgCO2e: '999999' }, { unexpected: 'value' },
  ])('rejects wrong field shape %j', async fields => {
    await expect(validate([{ ...row, ...fields }])).rejects.toBeInstanceOf(BadRequestException);
  });
  it('reports the four required fields on an empty object', async () => {
    try { await validate([{}]); throw new Error('expected validation failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ message: expect.arrayContaining([
        'activities.0.activityType must be a string', 'activities.0.recordDate must be a string',
        'activities.0.quantity must be a number conforming to the specified constraints', 'activities.0.unit must be a string',
      ]) });
    }
  });
  it('rejects the entire mixed request', async () => {
    await expect(validate([row, null, row])).rejects.toBeInstanceOf(BadRequestException);
  });
  it.each(['2026-03-07', '2026-03-07T12:30:00Z', '03/07/2026'])('preserves supported date string %s', async recordDate => {
    expect((await validate([{ ...row, recordDate }])).activities[0].recordDate).toBe(recordDate);
  });
  it.each([0, 2, '2', '002'])('preserves source row identity representation %j', async sourceRow => {
    expect((await validate([{ ...row, sourceRow }])).activities[0].sourceRow).toBe(sourceRow);
  });
  it('preserves lineage, frontend compatibility hints and numeric cost strings', async () => {
    const full = { ...row, sourceDocumentId: 'ignored', documentId: 'ignored', sourceType: 'DOCUMENT_AI',
      sourceFileName: 'invoice.xlsx', sourceSheetName: 'SheetA', sourceRow: '2', sourcePage: '1-2',
      sourceReference: 'ref', sourceTextSnippet: 'source text', importBatchId: 'row-batch', recordYear: 2026,
      dateEstimated: false, costCad: '12.50', matchingStatus: 'MATCHED', calculationStatus: 'CALCULATED',
      reportTreatment: 'INCLUDED', calculatedEmissionsKgCO2e: 999999, matchedFactorId: 'forged' };
    expect((await validate([full])).activities[0]).toEqual({ ...full, costCad: 12.5 });
  });
  it('accepts unsupported categories, missing province and incompatible units structurally', async () => {
    await expect(validate([row, { ...row, activityType: 'Office Supplies' },
      { ...row, activityType: 'ELECTRICITY', unit: 'kWh' }, { ...row, activityType: 'WATER', unit: 'm3' }])).resolves.toBeDefined();
  });
  it('preserves empty staged confirmation', async () => { await expect(validate([])).resolves.toBeDefined(); });
  it('accepts the F08 maximum and rejects maximum + 1', async () => {
    await expect(validate(Array.from({ length: MAX_EXTRACTED_REVIEW_ROWS }, () => ({ ...row })))).resolves.toBeDefined();
    await expect(validate(Array.from({ length: MAX_EXTRACTED_REVIEW_ROWS + 1 }, () => ({ ...row })))).rejects.toBeInstanceOf(BadRequestException);
  });
  it('keeps top-level unknown fields forbidden', async () => {
    await expect(validate([row], { unknown: true })).rejects.toBeInstanceOf(BadRequestException);
  });
});

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import { authHeader, cleanupTestData, createTestUser, uniqueTestId } from './helpers/factories';

type Row = { activityType: string; quantity: number; unit: string; recordDate: string; jurisdictionCountry: string;
  jurisdictionRegion?: string; sourceRow?: number; sourceReference?: string; sourceSheetName?: string;
  matchingStatus?: string; calculationStatus?: string; reportTreatment?: string; scope?: string;
  calculatedEmissionsKgCO2e?: number; matchedFactorId?: string };
const base: Row = { activityType: 'DIESEL', quantity: 10, unit: 'liters', recordDate: '2026-03-07', jurisdictionCountry: 'Canada' };
const spoof = { matchingStatus: 'MATCHED', calculationStatus: 'CALCULATED', reportTreatment: 'INCLUDED',
  calculatedEmissionsKgCO2e: 999999, matchedFactorId: 'forged-factor', scope: 'TRACKED_METRIC' };

describe('canonical document confirmation eligibility (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('confirm-eligibility');
  beforeAll(async () => { const setup = await createE2eApp(); app = setup.app; prisma = setup.prisma; });
  afterAll(async () => { await cleanupTestData(prisma, testRunId); await app.close(); });

  async function source(staged: boolean, inputs: Row[]) {
    const user = await createTestUser(app, { organizationName: `${testRunId} ${uniqueTestId()}`, email: `${uniqueTestId(testRunId)}@carbonlite-e2e.test`, factorProfile: 'reviewed' });
    await prisma.organization.update({ where: { id: user.user.organizationId }, data: { provinceState: null } });
    const auth = authHeader(user.accessToken);
    const rows = inputs.map((row, index) => ({ ...row, sourceRow: index + 2, sourceSheetName: 'Main', sourceReference: `source-${index}` }));
    let documentId: string;
    if (staged) {
      const saved = await request(app.getHttpServer()).post('/api/spreadsheet-import/review-rows').set(auth)
        .send({ sourceType: 'EXCEL', sourceFileName: `${testRunId}.xlsx`, importBatchId: uniqueTestId(testRunId), rows: rows.map(row => ({ ...row, rowId: `row-${row.sourceRow}`, status: 'READY', issues: [] })) }).expect(201);
      documentId = saved.body.sourceDocument.id;
    } else {
      const uploaded = await request(app.getHttpServer()).post('/api/documents/upload').set(auth).field('type', 'SPREADSHEET')
        .attach('file', Buffer.from('activityType,recordDate,quantity,unit\n'), { filename: `${testRunId}.csv`, contentType: 'text/csv' }).expect(201);
      documentId = uploaded.body.id;
      await prisma.documentExtraction.create({ data: { organizationId: user.user.organizationId, documentId,
        status: 'REVIEW_REQUIRED', extractedJson: { activities: rows }, extractedRows: rows,
        sourceRowCount: rows.length, extractedRowCount: rows.length, possibleMissingRows: true } });
    }
    const confirm = (activities: Row[] = rows) => request(app.getHttpServer()).post('/api/document-extraction/confirm').set(auth).send({ documentId, activities }).expect(201);
    return { ...user, auth, rows, documentId, confirm };
  }

  const blocked = [
    ['MISSING_FACTOR', { ...base, unit: 'kg' }],
    ['INVALID_UNIT', { ...base, unit: 'widgets' }],
    ['MISSING_JURISDICTION', { ...base, activityType: 'ELECTRICITY', unit: 'kWh' }],
    ['MISSING_FACTOR', { ...base, activityType: 'Office Supplies', unit: 'kg' }],
    ['INVALID_UNIT', { ...base, activityType: 'WATER', unit: 'widgets' }],
  ] as const;

  describe.each([false, true])('staged=%s parity', staged => {
    it.each(blocked)('blocks server %s despite spoofed client calculation fields (%j)', async (status, row) => {
      const ctx = await source(staged, [{ ...row, ...spoof }]);
      // Empty staged confirmation must also revalidate persisted READY hints.
      const result = await ctx.confirm(staged ? [] : ctx.rows);
      expect(result.body).toMatchObject({ count: 0, createdIds: [] });
      expect(await prisma.activityData.count({ where: { organizationId: ctx.user.organizationId } })).toBe(0);
      expect(await prisma.document.findUnique({ where: { id: ctx.documentId } })).toMatchObject({ status: 'REVIEW_REQUIRED', importedAt: null });
      const extraction = await request(app.getHttpServer()).get(`/api/document-extraction/${ctx.documentId}`).set(ctx.auth).expect(200);
      expect(extraction.body.parsedActivities).toHaveLength(1);
      if (staged) expect(await prisma.spreadsheetImportReviewRow.findFirst({ where: { sourceDocumentId: ctx.documentId } }))
        .toMatchObject({ status: 'NEEDS_REVIEW', calculationStatus: status });
    });

    it('imports a missing-province row only after Alberta is supplied', async () => {
      const ctx = await source(staged, [{ ...base, activityType: 'ELECTRICITY', quantity: 980, unit: 'kWh' }]);
      expect((await ctx.confirm()).body.count).toBe(0);
      const fixed = await ctx.confirm(ctx.rows.map(row => ({ ...row, jurisdictionRegion: 'Alberta' })));
      expect(fixed.body.count).toBe(1);
      expect(await prisma.activityData.findUnique({ where: { id: fixed.body.createdIds[0] } }))
        .toMatchObject({ jurisdictionRegion: 'Alberta', matchingStatus: 'MATCHED', calculationStatus: 'CALCULATED', reportTreatment: 'INCLUDED', calculatedEmissionsKgCO2e: 519.4 });
      expect((await ctx.confirm(ctx.rows.map(row => ({ ...row, jurisdictionRegion: 'Alberta' })))).body.count).toBe(0);
    });

    it('persists server-owned Gasoline calculation and provenance rather than forged values', async () => {
      const ctx = await source(staged, [{ ...base, activityType: 'GASOLINE', quantity: 350, unit: 'L', ...spoof }]);
      const result = await ctx.confirm();
      expect(result.body.count).toBe(1);
      const row = await prisma.activityData.findUniqueOrThrow({ where: { id: result.body.createdIds[0] } });
      expect(row).toMatchObject({ matchingStatus: 'MATCHED', calculationStatus: 'CALCULATED', reportTreatment: 'INCLUDED', scope: 'SCOPE_1', calculatedEmissionsKgCO2e: 808.5, matchedFactorValue: 2.31 });
      expect(row.matchedFactorId).not.toBe('forged-factor');
      expect(row.calculationSnapshot).toMatchObject({ factor: { value: 2.31 }, result: { value: 808.5, scope: 'SCOPE_1' } });
    });

    it('imports water as a tracked metric without a factor or GHG contribution', async () => {
      const ctx = await source(staged, [{ ...base, activityType: 'WATER', quantity: 18, unit: 'm3', ...spoof }]);
      const result = await ctx.confirm();
      expect(result.body.count).toBe(1);
      expect(await prisma.activityData.findUnique({ where: { id: result.body.createdIds[0] } }))
        .toMatchObject({ matchingStatus: 'TRACKED_ONLY', calculationStatus: 'TRACKED_ONLY', reportTreatment: 'TRACKED_ONLY', scope: 'TRACKED_METRIC', matchedFactorId: null, calculatedEmissionsKgCO2e: null });
      const summary = await request(app.getHttpServer()).get('/api/metrics/summary').set(ctx.auth).expect(200);
      expect(summary.body.totalEstimatedEmissionsKgCO2e).toBe(0);
    });

    it('partially imports mixed nine-row confirmation and keeps 3 -> 1 -> 0 retry behavior', async () => {
      const ctx = await source(staged, [
        { ...base, activityType: 'ELECTRICITY', quantity: 980, unit: 'kWh', jurisdictionRegion: 'Alberta' },
        { ...base, activityType: 'HOTEL', quantity: 4, unit: 'nights' },
        { ...base, activityType: 'WATER', quantity: 18, unit: 'm3' },
        { ...base, unit: 'kg' }, { ...base, activityType: 'ELECTRICITY', unit: 'kWh' },
        { ...base, activityType: 'Office Supplies', unit: 'kg' }, { ...base, activityType: 'GASOLINE', unit: 'kg' },
        { ...base, unit: 'widgets' }, { ...base, activityType: 'WATER', unit: 'widgets' },
      ].map(row => ({ ...row, ...spoof })));
      const first = await ctx.confirm();
      expect(first.body.count).toBe(3);
      const before = await prisma.activityData.findMany({ where: { sourceDocumentId: ctx.documentId }, orderBy: { id: 'asc' } });
      expect(before).toHaveLength(3);
      const summary = await request(app.getHttpServer()).get('/api/metrics/summary').set(ctx.auth).expect(200);
      expect(summary.body.totalEstimatedEmissionsKgCO2e).toBe(579.4);
      expect((await ctx.confirm()).body.count).toBe(0);
      expect(await prisma.document.findUnique({ where: { id: ctx.documentId } })).toMatchObject({ status: 'REVIEW_REQUIRED' });
      if (staged) expect(await prisma.spreadsheetImportReviewRow.count({ where: { sourceDocumentId: ctx.documentId, status: 'NEEDS_REVIEW' } })).toBe(6);
      const event = await prisma.userActivityEvent.findFirstOrThrow({ where: { entityId: ctx.documentId, eventName: 'ACTIVITY_RECORD_IMPORTED' } });
      expect(event.metadata).toMatchObject({ createdRecordCount: 3, trackedMetricCount: 1, unresolvedRowCount: 6, skippedCount: 6 });
      const corrected = ctx.rows.map((row, index) => index === 3 ? { ...row, unit: 'liters' } : row);
      expect((await ctx.confirm(corrected)).body.count).toBe(1);
      expect((await ctx.confirm(corrected)).body.count).toBe(0);
      expect(await prisma.activityData.count({ where: { sourceDocumentId: ctx.documentId } })).toBe(4);
      expect(await prisma.activityData.findMany({ where: { id: { in: before.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(before);
      expect(await prisma.document.findUnique({ where: { id: ctx.documentId } })).toMatchObject({ status: 'REVIEW_REQUIRED' });
    });
  });

  it('keeps an unstaged blocked-only request in review even without extraction artifacts', async () => {
    const ctx = await source(false, [{ ...base, unit: 'kg', ...spoof }]);
    await prisma.documentExtraction.delete({ where: { documentId: ctx.documentId } });
    expect((await ctx.confirm()).body.count).toBe(0);
    expect(await prisma.document.findUnique({ where: { id: ctx.documentId } })).toMatchObject({ status: 'REVIEW_REQUIRED', importedAt: null });
  });

  it('does not apply document eligibility rules to manual ActivityData creation', async () => {
    const ctx = await source(false, [base]);
    const manual = await request(app.getHttpServer()).post('/api/activity-data').set(ctx.auth).send({ ...base, unit: 'kg', sourceType: 'MANUAL' }).expect(201);
    expect(manual.body).toMatchObject({ calculationStatus: 'MISSING_FACTOR', calculatedEmissionsKgCO2e: null });
    expect(await prisma.activityData.findUnique({ where: { id: manual.body.id } })).not.toBeNull();
  });
});

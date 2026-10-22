import { assertSafeTestDatabaseTarget } from './helpers/database-safety';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { createE2eApp } from './helpers/e2e-app';
import { authHeader, cleanupTestData, createTestUser, TestUser, uniqueTestId } from './helpers/factories';

type Row = {
  activityType: string; quantity: number; unit: string; recordDate: string;
  jurisdictionCountry: string; jurisdictionRegion?: string;
  sourceRow?: number; sourceSheetName?: string; sourceReference?: string;
};
const base = { recordDate: '2026-03-07', jurisdictionCountry: 'Canada' };
const eligible: Row[] = [
  { ...base, activityType: 'ELECTRICITY', quantity: 980, unit: 'kWh', jurisdictionRegion: 'Alberta' },
  { ...base, activityType: 'HOTEL', quantity: 4, unit: 'nights' },
  { ...base, activityType: 'WATER', quantity: 18, unit: 'm3' },
].map((row, index) => ({ ...row, sourceRow: index + 2, sourceSheetName: 'Main', sourceReference: `ready-${index}` }));
const blocked: Row[] = [
  { ...base, activityType: 'DIESEL', quantity: 240, unit: 'kg' },
  { ...base, activityType: 'ELECTRICITY', quantity: 100, unit: 'kWh' },
  { ...base, activityType: 'Office Supplies', quantity: 10, unit: 'kg' },
  { ...base, activityType: 'GASOLINE', quantity: 10, unit: 'kg' },
  { ...base, activityType: 'DIESEL', quantity: 10, unit: 'widgets' },
  { ...base, activityType: 'WATER', quantity: 18, unit: 'widgets' },
].map((row, index) => ({ ...row, sourceRow: index + 5, sourceSheetName: 'Main', sourceReference: `blocked-${index}` }));
const forged = { matchingStatus: 'MATCHED', calculationStatus: 'CALCULATED', reportTreatment: 'INCLUDED', scope: 'TRACKED_METRIC', matchedFactorId: 'forged', calculatedEmissionsKgCO2e: 999999 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

describe('database-serialized document confirmation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('f05-concurrency');
  beforeAll(async () => {
    // No inherited/unknown target: this suite is intentionally local disposable DB only.
    const targetDatabase = assertSafeTestDatabaseTarget();
    const setup = await createE2eApp(); app = setup.app; prisma = app.select(PrismaModule).get(PrismaService, { strict: true });
    const [target] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    expect(target.name).toBe(targetDatabase.database);
  });
  afterAll(async () => { if (prisma) await cleanupTestData(prisma, testRunId); if (app) await app.close(); });

  async function source(staged: boolean, rows: Row[], existingUser?: TestUser) {
    const user = existingUser ?? await createTestUser(app, {
      organizationName: uniqueTestId(testRunId), email: `${uniqueTestId(testRunId)}@carbonlite-e2e.test`,
    });
    await prisma.organization.update({ where: { id: user.user.organizationId }, data: { provinceState: null } });
    const auth = authHeader(user.accessToken);
    let documentId: string;
    if (staged) {
      const saved = await request(app.getHttpServer()).post('/api/spreadsheet-import/review-rows').set(auth)
        .send({ sourceType: 'EXCEL', sourceFileName: `${testRunId}.xlsx`, importBatchId: uniqueTestId(testRunId),
          rows: rows.map((row, index) => ({ ...row, rowId: `row-${index}`, status: 'READY', issues: [] })) }).expect(201);
      documentId = saved.body.sourceDocument.id;
    } else {
      const document = await prisma.document.create({ data: { organizationId: user.user.organizationId,
        fileName: `${testRunId}.xlsx`, fileUrl: '/test-only/not-an-upload', status: 'REVIEW_REQUIRED' } });
      documentId = document.id;
      await prisma.documentExtraction.create({ data: { organizationId: user.user.organizationId, documentId,
        status: 'REVIEW_REQUIRED', extractedJson: { activities: rows }, extractedRows: rows,
        sourceRowCount: rows.length, extractedRowCount: rows.length } });
    }
    const confirm = (selection: Row[] = rows) => request(app.getHttpServer()).post('/api/document-extraction/confirm').set(auth)
      .send({ documentId, activities: selection }).then(response => response);
    const records = () => prisma.activityData.findMany({ where: { sourceDocumentId: documentId }, orderBy: { id: 'asc' } });
    const summary = () => request(app.getHttpServer()).get('/api/metrics/calculation-summary').set(auth)
      .query({ selectedDocumentIds: documentId }).expect(200);
    return { user, rows, documentId, auth, confirm, records, summary };
  }
  type Source = Awaited<ReturnType<typeof source>>;

  // Pause A AFTER its actual dedupe SELECT has completed. B is started and gets
  // its own backend PID while A remains in its transaction. Assert the real
  // PostgreSQL wait graph, not a sleep or an assumed winner, before releasing A.
  async function overlap(a: Source, aRows: Row[], b: Source = a, bRows = aRows, options = { independent: false, rollback: false }) {
    const held = deferred<void>();
    const release = deferred<void>();
    const secondEntered = deferred<number>();
    const original = prisma.$transaction.bind(prisma);
    let firstPid = 0;
    let transactionCount = 0;
    let rolledBackId: string | undefined;
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((callback: any, transactionOptions: any) =>
      original(async tx => {
        const index = transactionCount++;
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        if (index !== 0) { secondEntered.resolve(backend.pid); return callback(tx); }
        firstPid = backend.pid;
        const activityData = new Proxy(tx.activityData, {
          get(target, property) {
            if (property === 'findMany') return async (args: any) => {
              const records = await target.findMany(args);
              held.resolve(undefined);
              await release.promise;
              return records;
            };
            if (property === 'create' && options.rollback) return async (args: any) => {
              const record = await target.create(args);
              rolledBackId = record.id;
              throw new Error('Synthetic F05 failure after ActivityData insert');
            };
            return Reflect.get(target, property);
          },
        });
        return callback(new Proxy(tx, { get(target, property) {
          return property === 'activityData' ? activityData : Reflect.get(target, property);
        } }));
      }, transactionOptions)) as any);
    const requests: Array<Promise<any>> = [];
    try {
      requests.push(a.confirm(aRows));
      await deadline(Promise.race([held.promise, requests[0].then(response => { throw new Error('Request ended before barrier: ' + response.status + ' ' + JSON.stringify(response.body)); })]), 'first dedupe read');
      requests.push(b.confirm(bRows));
      const secondPid = await deadline(secondEntered.promise, 'second transaction entry');
      expect(secondPid).not.toBe(firstPid);
      if (options.independent) {
        // B must finish while A is still held, proving no global import lock.
        expect((await deadline(requests[1], 'independent document commit')).status).toBe(201);
      } else {
        const waitForDatabaseLock = async () => {
          const until = Date.now() + 5000;
          while (Date.now() < until) {
            const [state] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
              SELECT ${firstPid}::int = ANY(pg_blocking_pids(${secondPid}::int)) AS blocked`;
            if (state.blocked) return;
            await new Promise<void>(done => setImmediate(done));
          }
          release.resolve(undefined);
          const raced = await Promise.all(requests);
          const actual = await a.records();
          throw new Error('Second confirmation did not wait for the first document transaction; created counts=' + raced.map(result => result.body.count).join(',') + '; final records=' + actual.length);
        };
        await waitForDatabaseLock();
      }
      release.resolve(undefined);
      const results = await Promise.all(requests);
      expect(results.map(result => result.status)).toEqual(options.rollback ? [500, 201] : [201, 201]);
      return { results, rolledBackId };
    } finally {
      release.resolve(undefined);
      await Promise.allSettled(requests);
      spy.mockRestore();
    }
  }
  function totalCreated(results: any[]) { return results.reduce((sum, result) => sum + result.body.count, 0); }
  async function expectSingleContribution(ctx: Source) {
    const records = await ctx.records();
    expect(records).toHaveLength(3);
    expect(records.filter(row => row.calculationStatus === 'CALCULATED')).toHaveLength(2);
    expect(records.filter(row => row.calculationStatus === 'TRACKED_ONLY')).toHaveLength(1);
    expect((await ctx.summary()).body.totalEstimatedEmissionsKgCO2e).toBe(579.4);
    const events = await prisma.userActivityEvent.findMany({ where: { entityId: ctx.documentId, eventName: 'ACTIVITY_RECORD_IMPORTED' } });
    expect(events.reduce((sum, event) => sum + Number((event.metadata as any).createdRecordCount), 0)).toBe(3);
  }

  describe.each([false, true])('staged=%s', staged => {
    it('serializes the same selection and preserves IDs/totals on a lost-response retry', async () => {
      const ctx = await source(staged, eligible);
      const { results } = await overlap(ctx, ctx.rows);
      expect(totalCreated(results)).toBe(3);
      expect(results.flatMap(result => result.body.createdIds)).toHaveLength(3);
      await expectSingleContribution(ctx);
      const before = await ctx.records();
      // Deliberately ignore the committed response, then resend the same payload.
      await ctx.confirm();
      const retry = await ctx.confirm();
      expect(retry.status).toBe(201);
      expect(retry.body).toMatchObject({ count: 0, createdIds: [] });
      expect(await ctx.records()).toEqual(before);
      await expectSingleContribution(ctx);
    });

    it('deduplicates partially overlapping concurrent selections', async () => {
      const ctx = await source(staged, eligible);
      const { results } = await overlap(ctx, ctx.rows.slice(0, 2), ctx, ctx.rows.slice(1));
      expect(totalCreated(results)).toBe(3);
      await expectSingleContribution(ctx);
    });

    it('preserves F12 and concurrent partial confirmation 3 -> 1 -> 0', async () => {
      const ctx = await source(staged, [...eligible, ...blocked].map(row => ({ ...row, ...forged })));
      expect(totalCreated((await overlap(ctx, ctx.rows)).results)).toBe(3);
      await expectSingleContribution(ctx);
      expect(await prisma.document.findUnique({ where: { id: ctx.documentId } })).toMatchObject({ status: 'REVIEW_REQUIRED', importedAt: null });
      if (staged) expect(await prisma.spreadsheetImportReviewRow.count({ where: { sourceDocumentId: ctx.documentId, status: 'NEEDS_REVIEW' } })).toBe(6);
      const event = await prisma.userActivityEvent.findFirstOrThrow({ where: { entityId: ctx.documentId, eventName: 'ACTIVITY_RECORD_IMPORTED' } });
      expect(event.metadata).toMatchObject({ createdRecordCount: 3, trackedMetricCount: 1, unresolvedRowCount: 6 });
      const corrected = ctx.rows.map((row, index) => index === 3 ? { ...row, unit: 'L' } : row);
      expect(totalCreated((await overlap(ctx, corrected)).results)).toBe(1);
      expect(totalCreated((await overlap(ctx, corrected)).results)).toBe(0);
      expect(await ctx.records()).toHaveLength(4);
      expect((await ctx.summary()).body.totalEstimatedEmissionsKgCO2e).toBe(1222.6);
      if (staged) expect(await prisma.spreadsheetImportReviewRow.count({ where: { sourceDocumentId: ctx.documentId, status: 'NEEDS_REVIEW' } })).toBe(5);
    });

    it('keeps equal row numbers on separate sheets distinct, including retries', async () => {
      const ctx = await source(staged, ['SheetA', 'SheetB'].map(sourceSheetName => ({ ...eligible[0], sourceSheetName, sourceRow: 2 })));
      const { results } = await overlap(ctx, ctx.rows);
      expect(totalCreated(results)).toBe(2);
      expect((await ctx.records()).map(row => row.sourceSheetName).sort()).toEqual(['SheetA', 'SheetB']);
      expect((await ctx.confirm()).body.count).toBe(0);
      expect(await prisma.document.findUnique({ where: { id: ctx.documentId } })).toMatchObject({ status: 'IMPORTED' });
    });

    it('imports concurrent tracked water exactly once with zero GHG contribution', async () => {
      const ctx = await source(staged, [eligible[2]]);
      expect(totalCreated((await overlap(ctx, ctx.rows)).results)).toBe(1);
      expect(await ctx.records()).toEqual([expect.objectContaining({ activityType: 'WATER', quantity: expect.anything(), calculationStatus: 'TRACKED_ONLY', calculatedEmissionsKgCO2e: null })]);
      expect(Number((await ctx.records())[0].quantity)).toBe(18);
      expect((await ctx.summary()).body.totalEstimatedEmissionsKgCO2e).toBe(0);
    });
  });

  it('allows different documents in the same organization to commit independently', async () => {
    const a = await source(false, eligible);
    const b = await source(false, eligible, a.user);
    const { results } = await overlap(a, a.rows, b, b.rows, { independent: true, rollback: false });
    expect(results.map(result => result.body.count)).toEqual([3, 3]);
    await expectSingleContribution(a); await expectSingleContribution(b);
  });

  it('rolls back failed inserts and releases the document lock for an overlapping retry', async () => {
    const ctx = await source(true, eligible);
    const { results, rolledBackId } = await overlap(ctx, ctx.rows, ctx, ctx.rows, { independent: false, rollback: true });
    expect(results[1].body.count).toBe(3);
    expect(rolledBackId).toBeDefined();
    expect(await prisma.activityData.findUnique({ where: { id: rolledBackId } })).toBeNull();
    await expectSingleContribution(ctx);
    expect((await ctx.confirm()).body.count).toBe(0);
  });

  it('preserves IDs, snapshots, provenance and totals when deleting a concurrently confirmed source', async () => {
    const ctx = await source(false, eligible);
    expect(totalCreated((await overlap(ctx, ctx.rows)).results)).toBe(3);
    const before = await ctx.records();
    await request(app.getHttpServer()).delete(`/api/documents/${ctx.documentId}`).set(ctx.auth).expect(200)
      .expect({ deletedDocument: true, deletedActivityRecords: 0 });
    expect(await prisma.document.findUnique({ where: { id: ctx.documentId } })).toBeNull();
    expect(await ctx.records()).toEqual(before.map(row => ({ ...row, documentId: null })));
    const summary = await request(app.getHttpServer()).get('/api/metrics/calculation-summary').set(ctx.auth)
      .query({ selectedActivityRecordIds: before.map(row => row.id).join(',') }).expect(200);
    expect(summary.body.totalEstimatedEmissionsKgCO2e).toBe(579.4);
  });

  it('deduplicates legacy PDF/image rowless content on concurrent confirmation and retry', async () => {
    const ctx = await source(false, eligible.map(({ sourceRow, sourceSheetName, ...row }) => row));
    await prisma.document.update({ where: { id: ctx.documentId }, data: { fileName: 'evidence.pdf', mimeType: 'application/pdf' } });
    expect(totalCreated((await overlap(ctx, ctx.rows)).results)).toBe(3);
    await expectSingleContribution(ctx);
    expect((await ctx.confirm()).body.count).toBe(0);
  });
});

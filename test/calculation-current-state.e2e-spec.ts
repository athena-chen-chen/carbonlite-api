import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { CalculationSnapshotsService } from '../src/metrics/calculation-snapshots.service';
import { createE2eApp } from './helpers/e2e-app';
import { authHeader, cleanupTestData, createTestUser, uniqueTestId } from './helpers/factories';

describe('current calculation lifecycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('calculation-current');
  beforeAll(async () => { const setup = await createE2eApp(); app = setup.app; prisma = setup.prisma; });
  afterAll(async () => { await cleanupTestData(prisma, testRunId); await app.close(); });

  async function setup(source: 'MANUAL' | 'DOCUMENT' | 'SPREADSHEET' = 'MANUAL') {
    const user = await createTestUser(app, { organizationName: `${testRunId} ${source} ${uniqueTestId()}`, email: `${uniqueTestId(testRunId)}@carbonlite-e2e.test`, factorProfile: 'reviewed' });
    const auth = authHeader(user.accessToken);
    const row = { activityType: 'DIESEL', quantity: 10, unit: 'liters', recordDate: '2026-03-07', jurisdictionCountry: 'Canada', sourceReference: testRunId };
    let id: string;
    if (source === 'MANUAL') {
      const created = await request(app.getHttpServer()).post('/api/activity-data').set(auth).send({ ...row, sourceType: 'MANUAL' }).expect(201);
      id = created.body.id;
    } else {
      let documentId: string;
      if (source === 'DOCUMENT') {
        const uploaded = await request(app.getHttpServer()).post('/api/documents/upload').set(auth).field('type', 'SPREADSHEET')
          .attach('file', Buffer.from('activityType,recordDate,quantity,unit\nDiesel,2026-03-07,10,L\n'), { filename: `${testRunId}.csv`, contentType: 'text/csv' }).expect(201);
        documentId = uploaded.body.id;
      } else {
        const staged = await request(app.getHttpServer()).post('/api/spreadsheet-import/review-rows').set(auth)
          .send({ sourceType: 'EXCEL', sourceFileName: `${testRunId}.xlsx`, importBatchId: uniqueTestId(testRunId), rows: [{ ...row, rowId: 'diesel', sourceRow: 2, status: 'READY', issues: [] }] }).expect(201);
        documentId = staged.body.sourceDocument.id;
      }
      const confirmed = await request(app.getHttpServer()).post('/api/document-extraction/confirm').set(auth)
        .send({ documentId, activities: source === 'DOCUMENT' ? [{ ...row, sourceRow: 2 }] : [] }).expect(201);
      expect(confirmed.body.count).toBe(1);
      id = confirmed.body.createdIds[0];
    }
    await calculate(auth, id);
    const before = await prisma.activityData.findUniqueOrThrow({ where: { id } });
    expect(before.calculatedEmissionsKgCO2e).toBeCloseTo(26.8, 2);
    expect(before.calculationSnapshot).toBeTruthy();
    expect(await prisma.metricResult.count({ where: { activityDataId: id, metricType: 'CARBON_EMISSION' } })).toBe(1);
    return { auth, id, before, organizationId: user.user.organizationId };
  }

  async function calculate(auth: Record<string, string>, id: string) {
    return request(app.getHttpServer()).post('/api/metrics/calculate').set(auth)
      .send({ activityDataIds: [id], metricTypes: ['CARBON_EMISSION'] }).expect(201);
  }

  async function expectCurrent(auth: Record<string, string>, id: string, status: string, total: number) {
    const activity = await request(app.getHttpServer()).get(`/api/activity-data/${id}`).set(auth).expect(200);
    expect(activity.body.calculationStatus).toBe(status);
    const summary = await request(app.getHttpServer()).get('/api/metrics/summary').set(auth).expect(200);
    const report = await request(app.getHttpServer()).get('/api/metrics/calculation-summary').query({ selectedActivityRecordIds: id }).set(auth).expect(200);
    for (const result of [summary, report]) {
      expect(result.body.totalEstimatedEmissionsKgCO2e).toBeCloseTo(total, 2);
      expect(result.body.calculationDetails.find((row: { activityDataId: string }) => row.activityDataId === id))
        .toMatchObject({ status, calculatedEmissionsKgCO2e: status === 'CALCULATED' ? total : null });
      if (status !== 'CALCULATED') expect(result.body.matchedActivityEmissions).toEqual([]);
    }
    return report.body;
  }

  it.each(['MANUAL', 'DOCUMENT', 'SPREADSHEET'] as const)('%s: missing factor removes current emissions, repeated failures stay excluded, and recovery is clean', async source => {
    const { auth, id, before, organizationId } = await setup(source);
    const metric = await prisma.metricResult.findFirstOrThrow({ where: { activityDataId: id } });
    await request(app.getHttpServer()).patch(`/api/activity-data/${id}`).set(auth).send({ unit: 'kg' }).expect(200);
    expect(await prisma.metricResult.count({ where: { activityDataId: id } })).toBe(0);
    await expectCurrent(auth, id, 'MISSING_FACTOR', 0);
    // Pre-fix data can still contain an obsolete metric: reads must reject it.
    await prisma.metricResult.create({ data: { organizationId, activityDataId: id, metricType: 'CARBON_EMISSION', value: metric.value, unit: metric.unit, detailsJson: metric.detailsJson as Prisma.InputJsonValue } });
    await expectCurrent(auth, id, 'MISSING_FACTOR', 0);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await calculate(auth, id);
      expect(result.body.count).toBe(0);
      await expectCurrent(auth, id, 'MISSING_FACTOR', 0);
      const metrics = await request(app.getHttpServer()).get('/api/metrics').set(auth).expect(200);
      expect(metrics.body.items).toHaveLength(0);
    }
    const history = await prisma.auditLog.findMany({ where: { entityId: id, action: 'RECALCULATE_ACTIVITY_RECORD' } });
    expect(history.some(row => JSON.stringify(row.oldValue) === JSON.stringify(before.calculationSnapshot))).toBe(true);
    expect(history.filter(row => (row.newValue as { status?: string })?.status === 'MISSING_FACTOR')).toHaveLength(3);
    await request(app.getHttpServer()).patch(`/api/activity-data/${id}`).set(auth).send({ unit: 'liters', quantity: 20 }).expect(200);
    await calculate(auth, id);
    await expectCurrent(auth, id, 'CALCULATED', 53.6);
    expect(await prisma.metricResult.count({ where: { activityDataId: id, metricType: 'CARBON_EMISSION' } })).toBe(1);
    expect(await prisma.auditLog.findMany({ where: { id: { in: history.map(row => row.id) } }, orderBy: { id: 'asc' } }))
      .toEqual(history.slice().sort((a, b) => a.id.localeCompare(b.id)));
  });

  it.each([
    ['INVALID_UNIT', { unit: 'widgets' }],
    ['TRACKED_ONLY', { activityType: 'WATER', quantity: 18, unit: 'm3' }],
  ])('excludes %s transitions and retains their previous snapshots', async (status, changes) => {
    const { auth, id, before } = await setup();
    await request(app.getHttpServer()).patch(`/api/activity-data/${id}`).set(auth).send(changes).expect(200);
    await calculate(auth, id);
    await expectCurrent(auth, id, String(status), 0);
    expect(await prisma.metricResult.count({ where: { activityDataId: id } })).toBe(0);
    const history = await prisma.auditLog.findMany({ where: { entityId: id, action: 'RECALCULATE_ACTIVITY_RECORD' } });
    expect(history.some(row => JSON.stringify(row.oldValue) === JSON.stringify(before.calculationSnapshot))).toBe(true);
  });

  it('replaces successful recalculations without double counting', async () => {
    const { auth, id, before } = await setup();
    await request(app.getHttpServer()).patch(`/api/activity-data/${id}`).set(auth).send({ quantity: 20 }).expect(200);
    await calculate(auth, id);
    await calculate(auth, id);
    await expectCurrent(auth, id, 'CALCULATED', 53.6);
    expect(await prisma.metricResult.count({ where: { activityDataId: id, metricType: 'CARBON_EMISSION' } })).toBe(1);
    const history = await prisma.auditLog.findMany({ where: { entityId: id, action: 'RECALCULATE_ACTIVITY_RECORD' } });
    expect(history.some(row => JSON.stringify(row.oldValue) === JSON.stringify(before.calculationSnapshot))).toBe(true);
  });

  it('archives metric-only legacy evidence before invalidating the current projection', async () => {
    const { auth, id, organizationId } = await setup();
    const metric = await prisma.metricResult.findFirstOrThrow({ where: { activityDataId: id } });
    await prisma.activityData.update({ where: { id }, data: {
      calculationSnapshot: Prisma.DbNull, calculationVersion: 0, calculationStatus: null,
      reportTreatment: null, calculatedEmissionsKgCO2e: null,
    } });
    const legacy = await request(app.getHttpServer()).get('/api/metrics/calculation-summary')
      .query({ selectedActivityRecordIds: id }).set(auth).expect(200);
    expect(legacy.body.totalEstimatedEmissionsKgCO2e).toBeCloseTo(26.8, 2);
    await request(app.getHttpServer()).patch(`/api/activity-data/${id}`).set(auth).send({ unit: 'kg' }).expect(200);
    await expectCurrent(auth, id, 'MISSING_FACTOR', 0);
    expect(await prisma.metricResult.count({ where: { activityDataId: id } })).toBe(0);
    const history = await prisma.auditLog.findMany({ where: { organizationId, entityId: id, action: 'RECALCULATE_ACTIVITY_RECORD' } });
    expect(history.some(row => {
      const old = row.oldValue as { metricResults?: Array<{ id: string; value: string; detailsJson: unknown }> } | null;
      return old?.metricResults?.some(item => item.id === metric.id && item.value === '26.8' && JSON.stringify(item.detailsJson) === JSON.stringify(metric.detailsJson));
    })).toBe(true);
  });

  it('rolls back the state, projection and history together if the transition fails', async () => {
    const { id, before } = await setup();
    const metrics = await prisma.metricResult.findMany({ where: { activityDataId: id } });
    const history = await prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { id: 'asc' } });
    await expect(prisma.$transaction(async tx => {
      const row = await tx.activityData.update({ where: { id }, data: { unit: 'kg' } });
      await app.get(CalculationSnapshotsService).recalculate(tx, row);
      expect(await tx.metricResult.count({ where: { activityDataId: id } })).toBe(0);
      throw new Error('Synthetic transaction failure');
    })).rejects.toThrow('Synthetic transaction failure');
    expect(await prisma.activityData.findUniqueOrThrow({ where: { id } })).toEqual(before);
    expect(await prisma.metricResult.findMany({ where: { activityDataId: id } })).toEqual(metrics);
    expect(await prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { id: 'asc' } })).toEqual(history);
  });
});

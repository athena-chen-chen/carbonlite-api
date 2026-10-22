import { Prisma } from '@prisma/client';
import { persistedCalculationDetail } from './calculation-snapshot';
import { CalculationQualityService } from './calculation-quality.service';
import { CalculationSnapshotsService } from './calculation-snapshots.service';

const organization = { id: 'org', country: 'Canada', provinceState: 'Alberta', defaultReportingYear: 2026, allowDemoFactorsForCalculations: false };
const oldMetric = { id: 'old-metric', value: new Prisma.Decimal(26.8), unit: 'kgCO2e', detailsJson: { status: 'CALCULATED', factorValue: 2.68, factorUnit: 'liters' } };
const snapshot = { contractVersion: 1, version: 1, result: { value: 26.8 }, detail: { status: 'CALCULATED', calculatedEmissionsKgCO2e: 26.8 } };
const record = { id: 'record', organizationId: 'org', activityType: 'DIESEL', quantity: new Prisma.Decimal(10), unit: 'liters', recordDate: new Date('2026-03-07'), sourceType: 'MANUAL', document: null, metricResults: [oldMetric] };

describe('current calculation state outranks historical evidence', () => {
  it.each(['MISSING_FACTOR', 'INVALID_UNIT', 'TRACKED_ONLY', 'TRACKED_METRIC', 'NEEDS_REVIEW', 'REQUIRES_REVIEW'])('blocks %s from falling back to a metric or stale snapshot', status => {
    for (const calculationSnapshot of [null, snapshot]) {
      const row = { ...record, calculationStatus: status, calculationVersion: 2, calculationSnapshot };
      expect(persistedCalculationDetail(row, {})).toBeNull();
      const summary = new CalculationQualityService({} as never).evaluate({ organization, records: [row as never], factors: [], persistedOnly: true });
      expect(summary.totalEstimatedEmissionsKgCO2e).toBe(0);
      expect(summary.calculationDetails[0].status).toBe(status === 'TRACKED_METRIC' ? 'TRACKED_ONLY' : status);
      expect(summary.calculationDetails[0].calculatedEmissionsKgCO2e).toBeNull();
    }
  });

  it.each(['REQUIRES_REVIEW', 'TRACKED_ONLY', 'EXCLUDED'])('honors excluded report treatment %s even with calculated evidence', reportTreatment => {
    const row = { ...record, calculationStatus: 'CALCULATED', reportTreatment, calculationVersion: 1, calculationSnapshot: snapshot };
    expect(persistedCalculationDetail(row, {})).toBeNull();
    const summary = new CalculationQualityService({} as never).evaluate({ organization, records: [row as never], factors: [], persistedOnly: true });
    expect(summary.totalEstimatedEmissionsKgCO2e).toBe(0);
    expect(summary.calculationDetails[0].status).not.toBe('CALCULATED');
  });

  it('does not use a mismatched snapshot or metric for a versioned record', () => {
    expect(persistedCalculationDetail({ ...record, calculationStatus: 'CALCULATED', calculationVersion: 2, calculationSnapshot: snapshot }, {})).toBeNull();
    expect(persistedCalculationDetail({ ...record, calculationStatus: 'CALCULATED', calculationVersion: 2, calculationSnapshot: null }, {})).toBeNull();
  });

  it('retains genuine unversioned metric and activity-field compatibility without rematching', () => {
    expect(persistedCalculationDetail({ ...record, calculationVersion: 0 }, {})).toMatchObject({ status: 'CALCULATED', calculatedEmissionsKgCO2e: 26.8, snapshotSource: 'PERSISTED_METRIC' });
    expect(persistedCalculationDetail({ ...record, metricResults: [], calculationStatus: 'CALCULATED', matchedFactorValue: 2.68, calculatedEmissionsKgCO2e: 26.8 }, {})).toMatchObject({ status: 'CALCULATED', calculatedEmissionsKgCO2e: 26.8, snapshotSource: 'LEGACY_ACTIVITY_FIELDS' });
  });

  it('retains a matching current snapshot without looking up live factors', () => {
    expect(persistedCalculationDetail({ ...record, calculationStatus: 'CALCULATED', reportTreatment: 'INCLUDED', calculationVersion: 1, calculationSnapshot: snapshot }, {}))
      .toMatchObject({ status: 'CALCULATED', calculatedEmissionsKgCO2e: 26.8, calculationSnapshotVersion: 1 });
  });
});

describe('recalculation invalidates the carbon projection and retains history', () => {
  function setup() {
    const client = {
      activityData: { update: jest.fn(async ({ data }) => ({ ...record, ...data })) },
      metricResult: { findMany: jest.fn().mockResolvedValue([oldMetric]), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) }, userActivityEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new CalculationSnapshotsService(client as never, {} as never);
    return { client, service };
  }

  it.each(['MISSING_FACTOR', 'INVALID_UNIT', 'TRACKED_ONLY', 'CALCULATED'])('invalidates only this record carbon metrics for %s', async calculationStatus => {
    const { client, service } = setup();
    jest.spyOn(service, 'fields').mockResolvedValue({ calculationStatus, calculationVersion: 2, calculationSnapshot: calculationStatus === 'CALCULATED' ? { ...snapshot, version: 2 } : null });
    await service.recalculate(client as never, { ...record, calculationVersion: 1, calculationSnapshot: snapshot }, 'actor');
    expect(client.metricResult.deleteMany).toHaveBeenCalledWith({ where: { organizationId: 'org', activityDataId: 'record', metricType: 'CARBON_EMISSION' } });
    expect(client.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ oldValue: snapshot, newValue: expect.objectContaining({ status: calculationStatus }) }) });
    expect(snapshot.result.value).toBe(26.8);
  });

  it('archives metric-only legacy evidence before removing the old projection', async () => {
    const { client, service } = setup();
    jest.spyOn(service, 'fields').mockResolvedValue({ calculationStatus: 'MISSING_FACTOR', calculationVersion: 1, calculationSnapshot: null });
    await service.recalculate(client as never, { ...record, calculationVersion: 0, calculationSnapshot: null });
    expect(client.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ oldValue: expect.objectContaining({ metricResults: [expect.objectContaining({ id: 'old-metric', value: '26.8', detailsJson: oldMetric.detailsJson })] }) }) });
  });
  it('retains legacy activity-field evidence when no snapshot or metric exists', async () => {
    const { client, service } = setup();
    client.metricResult.findMany.mockResolvedValue([]);
    jest.spyOn(service, 'fields').mockResolvedValue({ calculationStatus: 'MISSING_FACTOR', calculationVersion: 1, calculationSnapshot: null });
    const legacy = { ...record, calculationSnapshot: null, calculationVersion: 0,
      calculationStatus: 'CALCULATED', matchedFactorValue: 2.68, calculatedEmissionsKgCO2e: 26.8 };
    await service.recalculate(client as never, legacy);
    expect(client.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      oldValue: { activityData: expect.objectContaining({ calculationStatus: 'CALCULATED', matchedFactorValue: 2.68, calculatedEmissionsKgCO2e: 26.8 }), metricResults: [] },
    }) });
  });

});

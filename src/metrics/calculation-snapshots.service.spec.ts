import { LEGITIMATE_ORGANIZATION_FACTOR } from '../test-support/legitimate-factor-metadata';
import { Prisma } from '@prisma/client';
import { CalculationQualityService } from './calculation-quality.service';
import { CalculationSnapshotsService } from './calculation-snapshots.service';

function setup(activityType = 'DIESEL', factorValue = 2.68, unit = 'L', allowDemoFactorsForCalculations = false) {
  const factor: any = { id: 'factor', organizationId: 'org', type: 'EMISSION', activityType, name: 'Customer corporate factor', unit, resultUnit: 'kgCO2e', factorValue: new Prisma.Decimal(factorValue), country: 'Canada', jurisdiction: 'Alberta', region: 'Alberta', sourceYear: 2025, isSystemDefault: false, ...LEGITIMATE_ORGANIZATION_FACTOR, applicability: 'CORPORATE_INVENTORY', emissionBasis: 'DIRECT_CO2E' };
  const client: any = { organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'org', country: 'Canada', provinceState: 'Alberta', allowDemoFactorsForCalculations }) }, conversionFactor: { findMany: jest.fn().mockResolvedValue([factor]) }, factorVersion: { findMany: jest.fn().mockResolvedValue([]) }, metricResult: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() }, activityData: { update: jest.fn(({ data }) => Promise.resolve(data)) }, auditLog: { create: jest.fn() }, userActivityEvent: { create: jest.fn() } };
  const quality = new CalculationQualityService(client);
  return { factor, client, quality, service: new CalculationSnapshotsService(client, quality) };
}
function input(activityType = 'DIESEL', quantity = 100, unit = 'L') {
  return { organizationId: 'org', activityType, quantity: new Prisma.Decimal(quantity), unit, recordDate: new Date('2026-10-14'), jurisdictionCountry: 'Canada', jurisdictionRegion: 'Alberta', sourceType: 'MANUAL', document: null };
}
it('captures server-owned input, actor, factor and result and ignores forged client results', async () => {
  const { service } = setup('ELECTRICITY', .53, 'kWh');
  const row = await service.prepareCreate((service as any).prisma, { ...input('ELECTRICITY', 980, 'kWh'), matchedFactorValue: 999, calculatedEmissionsKgCO2e: 999 }, 'actor');
  expect(row.calculatedEmissionsKgCO2e).toBe(519.4);
  expect(row.calculationSnapshot).toMatchObject({ contractVersion: 1, version: 1, actorUserId: 'actor', input: { quantity: 980, unit: 'kWh' }, factor: { value: .53 }, result: { value: 519.4, scope: 'SCOPE_2' } });
  expect(row.calculatedAt).toBeInstanceOf(Date);
});
it('retains 268 and copied provenance after library edits; explicit recalculation creates audited version 2', async () => {
  const { service, client, factor, quality } = setup();
  const row = await service.prepareCreate(client, input(), 'actor');
  const original = JSON.stringify(row.calculationSnapshot);
  factor.factorValue = new Prisma.Decimal(3.68); factor.sourceDocument = 'Changed current document';
  const summary = quality.evaluate({ organization: await client.organization.findUniqueOrThrow(), records: [row], factors: [factor], persistedOnly: true });
  expect(summary.totalEstimatedEmissionsKgCO2e).toBe(268);
  expect(summary.calculationDetails[0].sourceDocument).toBe(LEGITIMATE_ORGANIZATION_FACTOR.sourceDocument);
  expect(JSON.stringify(row.calculationSnapshot)).toBe(original);
  const updated = await service.recalculate(client, row, 'reviewer');
  expect(updated.calculationSnapshot).toMatchObject({ version: 2, actorUserId: 'reviewer', result: { value: 368 } });
  expect(client.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'RECALCULATE_ACTIVITY_RECORD', oldValue: { result: { value: 268 } }, newValue: { calculationSnapshot: { result: { value: 368 } } } });
});
it.each([-1, 0])('rejects quantity %s before any persistence', async quantity => {
  const { service, client } = setup();
  await expect(service.prepareCreate(client, input('DIESEL', quantity), 'actor')).rejects.toThrow('Quantity must be a positive number.');
  expect(client.activityData.update).not.toHaveBeenCalled();
});
it('does not rematch an uncalculated legacy record on a historical read', () => {
  const { quality, factor } = setup();
  const summary = quality.evaluate({ organization: { id: 'org', country: 'Canada', provinceState: 'Alberta', defaultReportingYear: null, allowDemoFactorsForCalculations: false }, records: [{ ...input(), id: 'legacy' } as any], factors: [factor], persistedOnly: true });
  expect(summary.totalEstimatedEmissionsKgCO2e).toBe(0);
  expect(summary.calculationDetails[0].status).toBe('MISSING_FACTOR');
});

// Known demo library labels: only these rename cases use persisted demo opt-in.
// This proves history/rename behavior, not factor methodology approval.
it('preserves historical library provenance after the current document is renamed', async () => {
  const { service, client, factor, quality } = setup('DIESEL', 2.68, 'L', true);
  factor.sourceDocument = 'CarbonLite MVP Default Factors v1.0';
  const row = await service.prepareCreate(client, input(), 'actor');
  const original = JSON.stringify(row);
  factor.sourceDocument = 'CarbonLite Default Factor Library v1.0';
  const historical = quality.evaluate({ organization: await client.organization.findUniqueOrThrow(), records: [row], factors: [factor], persistedOnly: true });
  expect(historical.totalEstimatedEmissionsKgCO2e).toBe(268);
  expect(historical.calculationDetails[0].sourceDocument).toBe('CarbonLite MVP Default Factors v1.0');
  expect(JSON.stringify(row)).toBe(original);
  const current = await service.prepareCreate(client, input(), 'actor');
  expect(current.matchedFactorSourceDocument).toBe('CarbonLite Default Factor Library v1.0');
  expect(current.calculatedEmissionsKgCO2e).toBe(268);
  expect(current.calculationSnapshot.factor.id).toBe(row.calculationSnapshot.factor.id);
  expect(current.calculationSnapshot.factor.value).toBe(row.calculationSnapshot.factor.value);
});

it.each([
  ['ELECTRICITY', 0.53, 'kWh', 53],
  ['NATURAL_GAS', 49.44, 'GJ', 4944],
  ['GASOLINE', 2.31, 'L', 231],
  ['DIESEL', 2.68, 'L', 268],
])('keeps %s matching and results identical across the document rename', async (activity, value, unit, total) => {
  const { factor, client, quality } = setup(String(activity), Number(value), String(unit), true);
  const organization = await client.organization.findUniqueOrThrow();
  const records: any[] = [{ ...input(String(activity), 100, String(unit)), id: 'rename-regression' }];
  const old = 'CarbonLite MVP Default Factors v1.0';
  const current = 'CarbonLite Default Factor Library v1.0';
  factor.sourceDocument = old;
  const before = quality.evaluate({ organization, records, factors: [factor], recalculate: true });
  factor.sourceDocument = current;
  const after = quality.evaluate({ organization, records, factors: [factor], recalculate: true });
  expect(after.totalEstimatedEmissionsKgCO2e).toBe(total);
  expect(after.calculationDetails[0].factorValue).toBe(value);
  expect(after.calculationDetails[0].sourceDocument).toBe(current);
  // Whole summaries, including IDs, matching reasons and fallback decisions, differ only by label.
  expect(JSON.stringify(after)).toBe(JSON.stringify(before).split(old).join(current));
});

// Identical candidate data; only the persisted organization policy varies.
it.each([false, true])('requires persisted demo authorization for legacy library labels (enabled=%s)', async enabled => {
  const { service, client, factor } = setup('DIESEL', 2.68, 'L', enabled);
  for (const sourceDocument of ['CarbonLite MVP Default Factors v1.0', 'CarbonLite Default Factor Library v1.0']) {
    factor.sourceDocument = sourceDocument;
    const row = await service.prepareCreate(client, input(), 'actor');
    expect(row.calculationStatus).toBe(enabled ? 'CALCULATED' : 'MISSING_FACTOR');
    expect(row.calculatedEmissionsKgCO2e).toBe(enabled ? 268 : null);
  }
  expect(client.organization.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 'org' } });
});

import { Prisma } from '@prisma/client';
import { CalculationQualityService } from './calculation-quality.service';
import { CalculationSnapshotsService } from './calculation-snapshots.service';

function setup(activityType = 'DIESEL', factorValue = 2.68, unit = 'L') {
  const factor: any = { id: 'factor', organizationId: 'org', type: 'EMISSION', activityType, name: 'Synthetic corporate factor', unit, resultUnit: 'kgCO2e', factorValue: new Prisma.Decimal(factorValue), country: 'Canada', jurisdiction: 'Alberta', region: 'Alberta', sourceYear: 2025, verified: true, isSystemDefault: false, sourceAuthority: 'Synthetic authority', sourceDocument: 'Synthetic reference', applicability: 'CORPORATE_INVENTORY', emissionBasis: 'DIRECT_CO2E' };
  const client: any = { organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'org', country: 'Canada', provinceState: 'Alberta', allowDemoFactorsForCalculations: false }) }, conversionFactor: { findMany: jest.fn().mockResolvedValue([factor]) }, factorVersion: { findMany: jest.fn().mockResolvedValue([]) }, activityData: { update: jest.fn(({ data }) => Promise.resolve(data)) }, auditLog: { create: jest.fn() }, userActivityEvent: { create: jest.fn() } };
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
  expect(summary.calculationDetails[0].sourceDocument).toBe('Synthetic reference');
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

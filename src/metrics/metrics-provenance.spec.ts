import { MetricTypeDto } from './dto/calculate-metrics.dto';
import { MetricsService } from './metrics.service';
import { Prisma } from '@prisma/client';
import { snapshotFactorProvenance } from '../conversion-factors/factor-governance';

describe('persisted calculation provenance', () => {
 it('persists governed identity and copied provenance without requiring a legacy FK', async () => {
  const source = { sourceAuthority: 'Alberta Environment and Protected Areas', sourceDocument: 'Test inventory source', sourceVersion: '3.2', sourceYear: 2025 };
  const detail = { activityDataId: 'record', status: 'CALCULATED', factorId: 'governed-factor', factorVersionId: 'version', factorValue: .53, factorInputUnit: 'kWh', factorResultUnit: 'kgCO2e', calculatedEmissionsKgCO2e: 519.4,
    factorProvenance: snapshotFactorProvenance({ id: 'version', factorId: 'governed-factor', source, applicability: 'CORPORATE_INVENTORY', emissionBasis: 'DIRECT_CO2E', factorYear: 2026 }) };
  const create = jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...data, id: 'result' }));
  const prisma = { activityData: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'record', calculationVersion: 0 }), findMany: jest.fn().mockResolvedValue([{ id: 'record', activityType: 'ELECTRICITY', unit: 'kWh', quantity: new Prisma.Decimal(980) }]) }, conversionFactor: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) }, metricResult: { deleteMany: jest.fn(), create } };
  (prisma as any).$transaction = (callback: any) => callback(prisma);
  const snapshot = { detail, result: { value: 519.4 } };
  const snapshots = { recalculate: jest.fn().mockResolvedValue({ calculationStatus: 'CALCULATED', calculationSnapshot: snapshot }) };
  const service = new MetricsService(prisma as never, { log: jest.fn() } as never, { buildSummary: jest.fn().mockResolvedValue({ calculationDetails: [detail] }) } as never, snapshots as never);
  const result = await service.calculate('org', { metricTypes: [MetricTypeDto.CARBON_EMISSION] });
  expect(result.count).toBe(1);
  const data = create.mock.calls[0][0].data;
  expect(data.factorId).toBeNull(); expect(data.factorVersionId).toBe('version');
  expect(Number(data.value)).toBe(519.4);
  source.sourceVersion = '3.3';
  expect(data.detailsJson.factorProvenance.sourceVersion).toBe('3.2');
 });
});

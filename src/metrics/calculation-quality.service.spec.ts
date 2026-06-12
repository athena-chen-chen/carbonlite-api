import { Prisma } from '@prisma/client';
import { CalculationQualityService } from './calculation-quality.service';

describe('CalculationQualityService', () => {
  const service = new CalculationQualityService(null as never);
  const organization = {
    id: 'org-1',
    provinceState: 'Alberta',
    country: 'Canada',
  };

  function record(overrides: Record<string, unknown> = {}) {
    return {
      id: 'activity-1',
      organizationId: 'org-1',
      facilityId: null,
      assetId: null,
      documentId: null,
      activityType: 'DIESEL',
      customTypeLabel: null,
      recordDate: new Date('2025-06-30T00:00:00.000Z'),
      periodStart: null,
      periodEnd: null,
      quantity: new Prisma.Decimal(100),
      unit: 'L',
      sourceType: 'MANUAL',
      sourceReference: 'test record',
      sourceFileName: null,
      sourceDocumentId: null,
      importBatchId: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      document: null,
      ...overrides,
    } as any;
  }

  function factor(overrides: Record<string, unknown> = {}) {
    return {
      id: 'factor-system',
      organizationId: null,
      name: 'Diesel factor',
      type: 'EMISSION',
      activityType: 'DIESEL',
      jurisdiction: 'Alberta, Canada',
      region: null,
      country: null,
      unit: 'liters',
      factorValue: new Prisma.Decimal(2.68),
      resultUnit: 'kgCO2e',
      sourceName: null,
      sourceReference: null,
      sourceAuthority: 'Test Authority',
      sourceDocument: 'Test factor table',
      sourceYear: 2025,
      sourceUrl: 'https://example.com/factor',
      methodology: null,
      confidenceLevel: null,
      verified: true,
      notes: null,
      effectiveFrom: null,
      effectiveTo: null,
      isDefault: true,
      isSystemDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as any;
  }

  it('calculates diesel quantity multiplied by the matched factor', () => {
    const result = service.evaluate({
      organization,
      records: [record()],
      factors: [factor()],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(268);
    expect(result.calculationDetails[0]).toMatchObject({
      status: 'CALCULATED',
      factorValue: 2.68,
      calculatedEmissionsKgCO2e: 268,
      factorInputUnit: 'liters',
      factorResultUnit: 'kgCO2e',
    });
  });

  it('matches electricity by jurisdiction and reporting year', () => {
    const result = service.evaluate({
      organization,
      records: [
        record({
          activityType: 'ELECTRICITY',
          quantity: new Prisma.Decimal(100),
          unit: 'kWh',
        }),
      ],
      factors: [
        factor({
          id: 'wrong-year',
          activityType: 'ELECTRICITY',
          unit: 'kWh',
          sourceYear: 2024,
          factorValue: new Prisma.Decimal(9),
        }),
        factor({
          id: 'correct-factor',
          activityType: 'ELECTRICITY',
          unit: 'kWh',
          sourceYear: 2025,
          factorValue: new Prisma.Decimal(0.5),
        }),
      ],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(50);
    expect(result.calculationDetails[0].factorId).toBe('correct-factor');
  });

  it('prefers an organization custom factor over a verified system factor', () => {
    const result = service.evaluate({
      organization,
      records: [record()],
      factors: [
        factor(),
        factor({
          id: 'factor-custom',
          organizationId: 'org-1',
          isSystemDefault: false,
          verified: false,
          factorValue: new Prisma.Decimal(3),
        }),
      ],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(300);
    expect(result.calculationDetails[0].factorPriority).toBe(
      'ORGANIZATION_CUSTOM',
    );
  });

  it('skips a record when no factor matches its unit', () => {
    const result = service.evaluate({
      organization,
      records: [record({ unit: 'tons' })],
      factors: [factor()],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(0);
    expect(result.calculationDetails[0].status).toBe('MISSING_FACTOR');
    expect(result.missingFactorCount).toBe(1);
  });

  it('skips invalid quantities and reports quality coverage', () => {
    const result = service.evaluate({
      organization,
      records: [
        record(),
        record({
          id: 'activity-invalid',
          quantity: new Prisma.Decimal(-1),
        }),
      ],
      factors: [factor()],
    });

    expect(result.recordsCalculated).toBe(1);
    expect(result.invalidRecordCount).toBe(1);
    expect(result.skippedRecords).toBe(1);
    expect(result.dataQualityCoverage).toBe(50);
    expect(result.calculationDetails[1].status).toBe('INVALID_QUANTITY');
  });

  it('does not combine incompatible fuel units', () => {
    const result = service.evaluate({
      organization,
      records: [
        record(),
        record({
          id: 'activity-gas',
          activityType: 'NATURAL_GAS',
          quantity: new Prisma.Decimal(400),
          unit: 'm3',
        }),
      ],
      factors: [
        factor(),
        factor({
          id: 'gas-factor',
          activityType: 'NATURAL_GAS',
          unit: 'm3',
          factorValue: new Prisma.Decimal(1),
        }),
      ],
    });

    expect(result.usageTotals.fuelUsageBreakdown).toEqual([
      { activityType: 'DIESEL', total: 100, unit: 'L' },
      { activityType: 'NATURAL_GAS', total: 400, unit: 'm3' },
    ]);
  });
});

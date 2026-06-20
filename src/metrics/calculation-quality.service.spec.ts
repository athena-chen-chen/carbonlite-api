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

  it('calculates 1000 L diesel x 2.68 = 2680 kgCO2e', () => {
    const result = service.evaluate({
      organization,
      records: [record({ quantity: new Prisma.Decimal(1000) })],
      factors: [factor()],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(2680);
    expect(result.calculationDetails[0]).toMatchObject({
      status: 'CALCULATED',
      activityQuantity: 1000,
      activityUnit: 'L',
      factorValue: 2.68,
      calculatedEmissionsKgCO2e: 2680,
      factorInputUnit: 'liters',
      factorResultUnit: 'kgCO2e',
    });
  });

  it('calculates 1000 m3 natural gas x 1.89 = 1890 kgCO2e', () => {
    const result = service.evaluate({
      organization,
      records: [
        record({
          activityType: 'NATURAL_GAS',
          quantity: new Prisma.Decimal(1000),
          unit: 'm3',
        }),
      ],
      factors: [
        factor({
          id: 'natural-gas-factor',
          name: 'Natural gas factor',
          activityType: 'NATURAL_GAS',
          unit: 'm3',
          factorValue: new Prisma.Decimal(1.89),
        }),
      ],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(1890);
    expect(result.calculationDetails[0]).toMatchObject({
      status: 'CALCULATED',
      activityQuantity: 1000,
      activityUnit: 'm3',
      factorValue: 1.89,
      calculatedEmissionsKgCO2e: 1890,
    });
  });

  it('calculates electricity using the selected factor value', () => {
    const electricityFactor = 0.5;
    const result = service.evaluate({
      organization,
      records: [
        record({
          activityType: 'ELECTRICITY',
          quantity: new Prisma.Decimal(1000),
          unit: 'kWh',
        }),
      ],
      factors: [
        factor({
          id: 'electricity-factor',
          activityType: 'ELECTRICITY',
          unit: 'kWh',
          factorValue: new Prisma.Decimal(electricityFactor),
        }),
      ],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(
      1000 * electricityFactor,
    );
    expect(result.calculationDetails[0]).toMatchObject({
      status: 'CALCULATED',
      factorId: 'electricity-factor',
      factorValue: electricityFactor,
      calculatedEmissionsKgCO2e: 500,
    });
  });

  it('matches an electricity factor by jurisdiction', () => {
    const result = service.evaluate({
      organization,
      records: [
        record({
          activityType: 'ELECTRICITY',
          quantity: new Prisma.Decimal(1000),
          unit: 'kWh',
        }),
      ],
      factors: [
        factor({
          id: 'british-columbia-factor',
          activityType: 'ELECTRICITY',
          unit: 'kWh',
          jurisdiction: 'British Columbia, Canada',
          sourceYear: 2025,
          factorValue: new Prisma.Decimal(0.02),
        }),
        factor({
          id: 'alberta-factor',
          activityType: 'ELECTRICITY',
          unit: 'kWh',
          jurisdiction: 'Alberta, Canada',
          sourceYear: 2025,
          factorValue: new Prisma.Decimal(0.5),
        }),
      ],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(500);
    expect(result.calculationDetails[0]).toMatchObject({
      factorId: 'alberta-factor',
      jurisdiction: 'Alberta, Canada',
    });
  });

  it('matches an electricity factor by reporting year', () => {
    const result = service.evaluate({
      organization,
      records: [
        record({
          activityType: 'ELECTRICITY',
          quantity: new Prisma.Decimal(1000),
          unit: 'kWh',
          recordDate: new Date('2025-06-30T00:00:00.000Z'),
        }),
      ],
      factors: [
        factor({
          id: 'electricity-2024',
          activityType: 'ELECTRICITY',
          unit: 'kWh',
          sourceYear: 2024,
          factorValue: new Prisma.Decimal(0.6),
        }),
        factor({
          id: 'electricity-2025',
          activityType: 'ELECTRICITY',
          unit: 'kWh',
          sourceYear: 2025,
          factorValue: new Prisma.Decimal(0.5),
        }),
      ],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(500);
    expect(result.calculationDetails[0]).toMatchObject({
      factorId: 'electricity-2025',
      reportingYear: 2025,
    });
  });

  it('prefers an organization custom factor over a verified system factor', () => {
    const result = service.evaluate({
      organization,
      records: [record({ quantity: new Prisma.Decimal(1000) })],
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

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(3000);
    expect(result.calculationDetails[0]).toMatchObject({
      factorId: 'factor-custom',
      factorValue: 3,
      factorPriority: 'ORGANIZATION_CUSTOM',
      calculatedEmissionsKgCO2e: 3000,
    });
  });

  it('returns missing-factor output when no factor matches', () => {
    const result = service.evaluate({
      organization,
      records: [
        record({
          activityType: 'WATER',
          quantity: new Prisma.Decimal(1000),
          unit: 'm3',
        }),
      ],
      factors: [],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(0);
    expect(result.recordsCalculated).toBe(0);
    expect(result.missingFactorCount).toBe(1);
    expect(result.missingFactors).toEqual([
      {
        activityDataId: 'activity-1',
        activityType: 'WATER',
        unit: 'm3',
        availableUnitsForActivityType: [],
      },
    ]);
    expect(result.calculationDetails[0]).toMatchObject({
      status: 'MISSING_FACTOR',
      factorId: null,
      calculatedEmissionsKgCO2e: null,
    });
  });

  it('marks an empty activity unit as invalid and excludes it', () => {
    const result = service.evaluate({
      organization,
      records: [record({ unit: '' })],
      factors: [factor()],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(0);
    expect(result.recordsCalculated).toBe(0);
    expect(result.invalidRecordCount).toBe(1);
    expect(result.skippedReasons.invalidUnit).toBe(1);
    expect(result.calculationDetails[0]).toMatchObject({
      status: 'INVALID_UNIT',
      reason: 'A valid activity unit is required.',
      factorId: null,
      calculatedEmissionsKgCO2e: null,
    });
  });

  it('does not silently use a liters factor for diesel reported in tons', () => {
    const result = service.evaluate({
      organization,
      records: [record({ quantity: new Prisma.Decimal(1), unit: 'tons' })],
      factors: [factor()],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(0);
    expect(result.calculationDetails[0]).toMatchObject({
      status: 'MISSING_FACTOR',
      activityUnit: 'tons',
      availableUnitsForActivityType: ['liters'],
    });
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

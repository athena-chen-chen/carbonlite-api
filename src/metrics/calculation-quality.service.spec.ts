import { Prisma } from '@prisma/client';
import { CalculationQualityService } from './calculation-quality.service';
import { normalizeJurisdictionRegion } from './metrics.utils';

describe('CalculationQualityService', () => {
  const service = new CalculationQualityService(null as never);
  const organization = {
    id: 'org-1',
    provinceState: 'Alberta',
    country: 'Canada',
    defaultReportingYear: null,
    allowDemoFactorsForCalculations: false,
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
      sourcePage: null,
      sourceRow: null,
      sourceTextSnippet: null,
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

  it('does not calculate electricity without a province', () => {
    const result = service.evaluate({
      organization: { ...organization, provinceState: null },
      records: [
        record({
          activityType: 'ELECTRICITY',
          quantity: new Prisma.Decimal(1000),
          unit: 'kWh',
          jurisdictionRegion: null,
          jurisdictionCountry: 'Canada',
        }),
      ],
      factors: [
        factor({
          id: 'electricity-factor',
          activityType: 'ELECTRICITY',
          unit: 'kWh',
          factorValue: new Prisma.Decimal(0.5),
        }),
      ],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(0);
    expect(result.calculationDetails[0]).toMatchObject({
      status: 'MISSING_JURISDICTION',
      matchingMessage:
        'Electricity emissions require a province-specific factor. Please select the province where the electricity was used.',
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
          jurisdiction: 'Alberta',
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
          jurisdiction: 'Alberta',
          sourceYear: 2024,
          factorValue: new Prisma.Decimal(0.6),
        }),
        factor({
          id: 'electricity-2025',
          activityType: 'ELECTRICITY',
          unit: 'kWh',
          jurisdiction: 'Alberta',
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
          verified: true,
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

  function source(overrides: Record<string, unknown> = {}) {
    return {
      id: 'source-eccc',
      sourceAuthority: 'Environment and Climate Change Canada',
      sourceShortName: 'ECCC',
      sourceDocument: 'Emission Factors and Reference Values',
      sourceVersion: '2025',
      sourceYear: 2025,
      sourceUrl: 'https://example.com/eccc.pdf',
      sourcePage: null,
      sourceTable: null,
      page: '',
      tableReference: '',
      publishedDate: new Date('2025-01-01T00:00:00.000Z'),
      country: 'Canada',
      jurisdictionRegion: 'Canada',
      publisherType: 'GOVERNMENT',
      description: null,
      notes: '',
      isOfficial: true,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as any;
  }

  function governedFactor(overrides: Record<string, unknown> = {}) {
    return {
      id: 'factor-version-ab-2025',
      factorId: 'factor-electricity-ab',
      version: 'v2025.1',
      factorValue: new Prisma.Decimal(0.5),
      inputUnit: 'kWh',
      resultUnit: 'kgCO2e',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Alberta',
      factorYear: 2025,
      effectiveFrom: null,
      effectiveTo: null,
      status: 'VERIFIED',
      confidenceLevel: 'OFFICIAL_GOVERNMENT',
      verified: true,
      reviewedBy: 'reviewer-1',
      reviewedAt: new Date(),
      reviewNotes: null,
      approvalSource: 'ECCC',
      sourceId: 'source-eccc',
      sourcePage: null,
      sourceSection: null,
      sourceTable: null,
      sourceRow: null,
      sourceColumn: null,
      citationText: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      factor: {
        id: 'factor-electricity-ab',
        activityType: 'ELECTRICITY',
        displayName: 'Electricity - Alberta',
        category: 'ELECTRICITY',
        scope: 'Scope 2',
        description: null,
        isSystem: true,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      source: source(),
      ...overrides,
    } as any;
  }

  it('uses Alberta electricity 2025 factor for Alberta 2025 records', () => {
    const result = service.evaluate({
      organization,
      records: [
        record({
          activityType: 'ELECTRICITY',
          quantity: new Prisma.Decimal(1000),
          unit: 'KWH',
          recordDate: new Date('2025-06-30T00:00:00.000Z'),
          jurisdictionRegion: 'Alberta',
          jurisdictionCountry: 'Canada',
          sourceType: 'AI_EXTRACTION',
          sourceFileName: 'electricity-bill.pdf',
          sourceReference: 'Utility charges',
          sourcePage: '2',
          sourceRow: '5',
          sourceTextSnippet: 'Electricity usage 1000 kWh',
        }),
      ],
      factors: [],
      governedFactors: [
        governedFactor({
          sourcePage: '12',
          sourceTable: 'Table 3',
        }),
      ],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(500);
    expect(result.calculationDetails[0]).toMatchObject({
      factorVersionId: 'factor-version-ab-2025',
      matchedBy: 'SYSTEM_EXACT_REGION_YEAR',
      matchingStatus: 'MATCHED',
      factorDisplayName: 'Electricity - Alberta',
      sourceAuthority: 'Environment and Climate Change Canada',
      sourceDocument: 'Emission Factors and Reference Values',
      factorSourcePage: '12',
      factorSourceTable: 'Table 3',
      calculationFormula: '1000 kwh × 0.5 kgCO2e/kWh = 500 kgCO2e',
      sourceFileName: 'electricity-bill.pdf',
      sourcePage: '2',
      sourceRow: '5',
      sourceTextSnippet: 'Electricity usage 1000 kWh',
      normalizedUnit: 'kwh',
    });
    expect(result.conversionFactorsUsed[0]).toMatchObject({
      factorVersionId: 'factor-version-ab-2025',
      sourcePage: '12',
      sourceTable: 'Table 3',
      usedRecordsCount: 1,
    });
    expect(result.matchedActivityEmissions[0]).toMatchObject({
      factorVersionId: 'factor-version-ab-2025',
      calculationFormula: '1000 kwh × 0.5 kgCO2e/kWh = 500 kgCO2e',
      sourceFileName: 'electricity-bill.pdf',
      sourcePage: '2',
    });
  });

  it('does not use Alberta electricity factor for British Columbia records', () => {
    const result = service.evaluate({
      organization: { ...organization, provinceState: 'British Columbia' },
      records: [
        record({
          activityType: 'ELECTRICITY',
          quantity: new Prisma.Decimal(1000),
          unit: 'kWh',
          jurisdictionRegion: 'British Columbia',
          jurisdictionCountry: 'Canada',
        }),
      ],
      factors: [],
      governedFactors: [governedFactor()],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(0);
    expect(result.calculationDetails[0]).toMatchObject({
      status: 'MISSING_FACTOR',
      matchingMessage:
        'No electricity factor found for British Columbia, 2025. Electricity factors must be jurisdiction-specific.',
    });
  });

  it('uses facility jurisdiction before organization default for BC electricity', () => {
    const result = service.evaluate({
      organization: { ...organization, provinceState: 'Alberta' },
      records: [
        record({
          activityType: 'ELECTRICITY',
          quantity: new Prisma.Decimal(1000),
          unit: 'kWh',
          jurisdictionRegion: null,
          jurisdictionCountry: null,
          facilityId: 'facility-bc',
          facility: {
            id: 'facility-bc',
            name: 'Vancouver Office',
            country: 'Canada',
            provinceState: 'BC',
          },
        }),
      ],
      factors: [],
      governedFactors: [
        governedFactor({
          id: 'factor-version-bc-2025',
          factorValue: new Prisma.Decimal(0.02),
          jurisdictionRegion: 'British Columbia',
          factor: {
            id: 'factor-electricity-bc',
            activityType: 'ELECTRICITY',
            displayName: 'Electricity - British Columbia',
            category: 'ELECTRICITY',
            scope: 'Scope 2',
            description: null,
            isSystem: true,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        }),
        governedFactor({
          id: 'factor-version-ab-2025',
          factorValue: new Prisma.Decimal(0.5),
          jurisdictionRegion: 'Alberta',
        }),
      ],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(20);
    expect(result.calculationDetails[0]).toMatchObject({
      factorVersionId: 'factor-version-bc-2025',
      jurisdictionRegion: 'British Columbia',
      jurisdictionSource: 'facility',
      facilityName: 'Vancouver Office',
      matchedBy: 'SYSTEM_EXACT_REGION_YEAR',
      matchingMessage:
        'Matched British Columbia electricity factor for 2025 because the selected facility is located there.',
    });
  });

  it('uses Canada-level fuel factor for BC records when province-specific fuel factor is absent', () => {
    const result = service.evaluate({
      organization,
      records: [
        record({
          activityType: 'DIESEL',
          quantity: new Prisma.Decimal(100),
          unit: 'liters',
          facilityId: 'facility-bc',
          facility: {
            id: 'facility-bc',
            name: 'Vancouver Office',
            country: 'Canada',
            provinceState: 'British Columbia',
          },
        }),
      ],
      factors: [
        factor({
          id: 'diesel-canada',
          jurisdiction: 'Canada (Generic)',
          region: null,
          country: 'Canada',
          sourceYear: 2025,
          factorValue: new Prisma.Decimal(2.68),
        }),
      ],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(268);
    expect(result.calculationDetails[0]).toMatchObject({
      factorId: 'diesel-canada',
      jurisdictionRegion: 'British Columbia',
      jurisdictionSource: 'facility',
      factorJurisdictionCountry: 'Canada',
      matchedBy: 'SYSTEM_COUNTRY_YEAR',
      matchingMessage:
        'Used Canada-level default factor because no province-specific factor was available for Diesel. Jurisdiction came from the selected facility.',
    });
  });

  it('normalizes Canadian province names', () => {
    expect(normalizeJurisdictionRegion('AB')).toBe('Alberta');
    expect(normalizeJurisdictionRegion('Alta.')).toBe('Alberta');
    expect(normalizeJurisdictionRegion('BC')).toBe('British Columbia');
    expect(normalizeJurisdictionRegion('B.C.')).toBe('British Columbia');
    expect(normalizeJurisdictionRegion('ON')).toBe('Ontario');
    expect(normalizeJurisdictionRegion('Ont.')).toBe('Ontario');
    expect(normalizeJurisdictionRegion(null)).toBeNull();
  });

  it('uses nearest prior year factor with warning', () => {
    const result = service.evaluate({
      organization,
      records: [
        record({
          activityType: 'ELECTRICITY',
          quantity: new Prisma.Decimal(1000),
          unit: 'kWh',
          recordDate: new Date('2026-06-30T00:00:00.000Z'),
          jurisdictionRegion: 'Alberta',
          jurisdictionCountry: 'Canada',
        }),
      ],
      factors: [],
      governedFactors: [governedFactor()],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(500);
    expect(result.calculationDetails[0]).toMatchObject({
      matchingStatus: 'MATCHED_PRIOR_YEAR',
      matchedBy: 'PRIOR_YEAR',
      factorYear: 2025,
      recordYear: 2026,
    });
  });

  it('uses country-level fuel factor when province-specific factor is absent', () => {
    const result = service.evaluate({
      organization,
      records: [record({ quantity: new Prisma.Decimal(1000), unit: 'LTR' })],
      factors: [],
      governedFactors: [
        governedFactor({
          id: 'diesel-canada-2025',
          factorValue: new Prisma.Decimal(2.68),
          inputUnit: 'liters',
          jurisdictionRegion: 'Canada',
          factor: {
            id: 'factor-diesel-canada',
            activityType: 'DIESEL',
            displayName: 'Diesel - Canada',
            category: 'FUEL',
            scope: 'Scope 1',
            description: null,
            isSystem: true,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        }),
      ],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(2680);
    expect(result.calculationDetails[0]).toMatchObject({
      factorVersionId: 'diesel-canada-2025',
      matchedBy: 'SYSTEM_COUNTRY_YEAR',
    });
  });

  it('does not use demo factors by default', () => {
    const result = service.evaluate({
      organization,
      records: [record({ quantity: new Prisma.Decimal(1000) })],
      factors: [],
      governedFactors: [
        governedFactor({
          id: 'demo-diesel',
          inputUnit: 'liters',
          status: 'DRAFT',
          confidenceLevel: 'DEMO',
          verified: false,
          factor: {
            id: 'factor-demo-diesel',
            activityType: 'DIESEL',
            displayName: 'Demo Diesel',
            category: 'FUEL',
            scope: 'Scope 1',
            description: null,
            isSystem: true,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        }),
      ],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(0);
    expect(result.calculationDetails[0].status).toBe('MISSING_FACTOR');
  });

  it('invalid numeric unit prevents calculation', () => {
    const result = service.evaluate({
      organization,
      records: [record({ unit: '20', quantity: new Prisma.Decimal(1000) })],
      factors: [factor()],
    });

    expect(result.totalEstimatedEmissionsKgCO2e).toBe(0);
    expect(result.calculationDetails[0]).toMatchObject({
      status: 'INVALID_UNIT',
      reason: 'Unit could not be normalized or matched to a supported factor unit.',
    });
  });

  it('treats water as a tracked-only metric by default', () => {
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
    expect(result.missingFactorCount).toBe(0);
    expect(result.missingFactors).toEqual([]);
    expect(result.calculationDetails[0]).toMatchObject({
      status: 'TRACKED_ONLY',
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
      reason: 'Unit could not be normalized or matched to a supported factor unit.',
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

  it('filters calculation summaries by selected document ids', () => {
    const result = service.evaluate({
      organization,
      records: [
        record({
          id: 'activity-doc-1',
          sourceDocumentId: 'doc-1',
          quantity: new Prisma.Decimal(100),
        }),
        record({
          id: 'activity-doc-2',
          documentId: 'doc-2',
          quantity: new Prisma.Decimal(200),
        }),
      ],
      factors: [factor()],
      query: { selectedDocumentIds: 'doc-1' },
    });

    expect(result.totalRecordsFound).toBe(2);
    expect(result.recordsInScope).toBe(1);
    expect(result.totalRecordCount).toBe(1);
    expect(result.calculatedRecordCount).toBe(1);
    expect(result.skippedRecordCount).toBe(0);
    expect(result.totalEstimatedEmissionsKgCO2e).toBe(268);
    expect(result.calculationDetails).toHaveLength(1);
    expect(result.calculationDetails[0]).toMatchObject({
      activityDataId: 'activity-doc-1',
      sourceDocumentId: 'doc-1',
      status: 'CALCULATED',
    });
  });

  it('accepts selected document ids as arrays and comma-separated values', () => {
    const result = service.evaluate({
      organization,
      records: [
        record({
          id: 'activity-doc-1',
          sourceDocumentId: 'doc-1',
          quantity: new Prisma.Decimal(100),
        }),
        record({
          id: 'activity-doc-2',
          documentId: 'doc-2',
          quantity: new Prisma.Decimal(200),
        }),
        record({
          id: 'activity-doc-3',
          sourceDocumentId: 'doc-3',
          quantity: new Prisma.Decimal(300),
        }),
      ],
      factors: [factor()],
      query: { selectedDocumentIds: ['doc-1,doc-2'] },
    });

    expect(result.recordsInScope).toBe(2);
    expect(result.totalRecordCount).toBe(2);
    expect(result.totalEstimatedEmissionsKgCO2e).toBe(804);
    expect(result.calculationDetails.map((detail) => detail.activityDataId)).toEqual([
      'activity-doc-1',
      'activity-doc-2',
    ]);
  });

  it('accepts bracket selected document ids and returns an empty scoped summary when none match', () => {
    const result = service.evaluate({
      organization,
      records: [
        record({
          id: 'activity-doc-1',
          sourceDocumentId: 'doc-1',
        }),
      ],
      factors: [factor()],
      query: { 'selectedDocumentIds[]': ['missing-doc'] },
    });

    expect(result.totalRecordsFound).toBe(1);
    expect(result.recordsInScope).toBe(0);
    expect(result.totalRecordCount).toBe(0);
    expect(result.recordsCalculated).toBe(0);
    expect(result.skippedRecordCount).toBe(0);
    expect(result.totalEstimatedEmissionsKgCO2e).toBe(0);
    expect(result.calculationDetails).toEqual([]);
    expect(result.records).toEqual([]);
    expect(result.activities).toEqual([]);
  });
});

import { BadRequestException } from '@nestjs/common';
import { ActivityType, RecordSourceType } from '@prisma/client';
import {
  buildJsonActivityPreview,
  parseJsonActivityPayload,
} from './json-activity-records';

const baseRecord = {
  facilityName: 'Calgary Main Office',
  serviceLocation: 'Calgary, AB',
  province: 'AB',
  activityType: 'Electricity',
  amount: 12500,
  unit: 'kWh',
  startDate: '2026-01-01',
  endDate: '2026-01-31',
};

const electricityFactor = {
  id: 'electricity-ab-2026',
  name: 'Electricity - Alberta',
  activityType: ActivityType.ELECTRICITY,
  unit: 'kWh',
  factorValue: 0.53,
  resultUnit: 'kgCO2e',
  region: 'Alberta',
  country: 'Canada',
  sourceYear: 2026,
};

function electricityPreviewFactor(input: {
  id: string;
  name: string;
  province: string;
  sourceYear: number;
  factorValue: number;
}) {
  return {
    id: input.id,
    name: input.name,
    activityType: ActivityType.ELECTRICITY,
    unit: 'kWh',
    factorValue: input.factorValue,
    resultUnit: 'kgCO2e',
    jurisdiction: input.province,
    region: input.province,
    country: 'Canada',
    sourceYear: input.sourceYear,
  };
}

const manualEntryElectricityFactors = [
  electricityPreviewFactor({
    id: 'electricity-sk-2026',
    name: 'Electricity - Saskatchewan',
    province: 'Saskatchewan',
    sourceYear: 2026,
    factorValue: 0.64,
  }),
  electricityPreviewFactor({
    id: 'electricity-ab-2024',
    name: 'Electricity - Alberta 2024',
    province: 'Alberta',
    sourceYear: 2024,
    factorValue: 0.56,
  }),
  electricityPreviewFactor({
    id: 'electricity-ab-2025',
    name: 'Electricity - Alberta',
    province: 'Alberta',
    sourceYear: 2025,
    factorValue: 0.53,
  }),
  electricityPreviewFactor({
    id: 'electricity-bc-2025',
    name: 'Electricity - British Columbia',
    province: 'British Columbia',
    sourceYear: 2025,
    factorValue: 0.02,
  }),
  electricityPreviewFactor({
    id: 'electricity-on-2025',
    name: 'Electricity - Ontario',
    province: 'Ontario',
    sourceYear: 2025,
    factorValue: 0.12,
  }),
];

const naturalGasFactor = {
  activityType: ActivityType.NATURAL_GAS,
  unit: 'm3',
  region: 'Canada',
  country: 'Canada',
  sourceYear: 2026,
};

const flightFactor = {
  activityType: ActivityType.AIR_TRAVEL,
  unit: 'km',
  region: 'Canada',
  country: 'Canada',
  sourceYear: 2026,
};

const groundTransportFactor = {
  id: 'ground-transport-ca-2025',
  name: 'Ground Transport - Canada - 2025',
  activityType: ActivityType.GROUND_TRANSPORT,
  unit: 'km',
  factorValue: 0.2,
  resultUnit: 'kgCO2e',
  jurisdiction: 'Canada - National',
  country: 'Canada',
  sourceYear: 2025,
};

describe('JSON activity records', () => {
  it('parses a CarbonLite wrapper object with activityRecords', () => {
    const records = parseJsonActivityPayload({
      jsonContent: JSON.stringify({
        datasetName: 'Demo',
        activityRecords: [baseRecord],
      }),
    });

    expect(records).toHaveLength(1);
    expect(records[0].facilityName).toBe('Calgary Main Office');
  });

  it('parses a bare array format', () => {
    const records = parseJsonActivityPayload({
      jsonContent: JSON.stringify([baseRecord]),
    });

    expect(records).toHaveLength(1);
  });

  it('rejects malformed JSON with a friendly error', () => {
    expect(() => parseJsonActivityPayload({ jsonContent: '{nope' })).toThrow(
      new BadRequestException(
        'Invalid JSON file. Please check the file format and try again.',
      ),
    );
  });

  it('rejects unsupported object shape with a friendly error', () => {
    expect(() =>
      parseJsonActivityPayload({ jsonContent: JSON.stringify({ records: [baseRecord] }) }),
    ).toThrow(
      new BadRequestException(
        'Unable to find activityRecords in this JSON file. Please upload a CarbonLite activity records JSON file.',
      ),
    );
  });

  it('classifies Electricity with province as Scope 2 and Matched', () => {
    const preview = buildJsonActivityPreview({
      records: [{ ...baseRecord, activityType: 'electricity', amount: '12,500' }],
      factors: [electricityFactor],
    });

    expect(preview.records[0]).toMatchObject({
      activityType: 'Electricity',
      amount: 12500,
      scope: 'Scope 2',
      matchedFactorStatus: 'Matched',
      reportTreatment: 'Included',
      canImport: true,
    });
  });

  it('matches Manual Entry preview Electricity + Alberta + kWh + 2026 to the latest Alberta prior-year factor', () => {
    const preview = buildJsonActivityPreview({
      records: [
        {
          ...baseRecord,
          activityType: 'ELECTRICITY',
          province: 'Alberta',
          amount: 100,
          unit: 'kWh',
          date: '2026-07-20',
          startDate: undefined,
          endDate: undefined,
        },
      ],
      factors: manualEntryElectricityFactors,
    });

    expect(preview.records[0]).toMatchObject({
      activityType: 'Electricity',
      scope: 'Scope 2',
      matchedFactorStatus: 'Matched',
      reportTreatment: 'Included',
      matchedFactor: {
        id: 'electricity-ab-2025',
        name: 'Electricity - Alberta',
        factorValue: 0.53,
        value: 0.53,
        unit: 'kWh',
        sourceYear: 2025,
        jurisdictionRegion: 'Alberta',
      },
      estimatedEmissionsKgCO2e: 53,
      estimatedEmissionsStatus: 'Calculated',
    });
  });

  it('matches Manual Entry preview Electricity + BC + kWh + 2026 to the BC prior-year factor', () => {
    const preview = buildJsonActivityPreview({
      records: [
        {
          ...baseRecord,
          activityType: 'ELECTRICITY',
          province: 'British Columbia',
          amount: 100,
          unit: 'kWh',
          date: '2026-07-20',
          startDate: undefined,
          endDate: undefined,
        },
      ],
      factors: manualEntryElectricityFactors,
    });

    expect(preview.records[0]).toMatchObject({
      matchedFactorStatus: 'Matched',
      matchedFactor: {
        id: 'electricity-bc-2025',
        factorValue: 0.02,
        sourceYear: 2025,
      },
      estimatedEmissionsKgCO2e: 2,
    });
  });

  it('matches Manual Entry preview Electricity + ON + kWh + 2026 to the Ontario prior-year factor', () => {
    const preview = buildJsonActivityPreview({
      records: [
        {
          ...baseRecord,
          activityType: 'ELECTRICITY',
          province: 'Ontario',
          amount: 100,
          unit: 'kWh',
          date: '2026-07-20',
          startDate: undefined,
          endDate: undefined,
        },
      ],
      factors: manualEntryElectricityFactors,
    });

    expect(preview.records[0]).toMatchObject({
      matchedFactorStatus: 'Matched',
      matchedFactor: {
        id: 'electricity-on-2025',
        factorValue: 0.12,
        sourceYear: 2025,
      },
      estimatedEmissionsKgCO2e: 12,
    });
  });

  it('keeps Manual Entry preview factor matched when quantity is empty', () => {
    const preview = buildJsonActivityPreview({
      records: [
        {
          ...baseRecord,
          activityType: 'ELECTRICITY',
          province: 'Alberta',
          amount: '',
          unit: 'kWh',
          date: '2026-07-20',
          startDate: undefined,
          endDate: undefined,
        },
      ],
      factors: manualEntryElectricityFactors,
    });

    expect(preview.records[0]).toMatchObject({
      matchedFactorStatus: 'Matched',
      reportTreatment: 'Included',
      matchedFactor: {
        id: 'electricity-ab-2025',
        name: 'Electricity - Alberta',
        sourceYear: 2025,
      },
      estimatedEmissionsKgCO2e: null,
      estimatedEmissionsStatus: 'Waiting for quantity',
      canImport: false,
    });
    expect(preview.records[0].validationErrors).toContain(
      'Amount must be a valid number.',
    );
  });

  it('uses the latest prior-year Manual Entry preview factor instead of an older prior year', () => {
    const preview = buildJsonActivityPreview({
      records: [
        {
          ...baseRecord,
          activityType: 'ELECTRICITY',
          province: 'Alberta',
          amount: 100,
          unit: 'kWh',
          date: '2026-07-20',
          startDate: undefined,
          endDate: undefined,
        },
      ],
      factors: [
        electricityPreviewFactor({
          id: 'electricity-ab-2023',
          name: 'Electricity - Alberta 2023',
          province: 'Alberta',
          sourceYear: 2023,
          factorValue: 0.6,
        }),
        electricityPreviewFactor({
          id: 'electricity-ab-2025',
          name: 'Electricity - Alberta',
          province: 'Alberta',
          sourceYear: 2025,
          factorValue: 0.53,
        }),
      ],
    });

    expect(preview.records[0].matchedFactor).toMatchObject({
      id: 'electricity-ab-2025',
      sourceYear: 2025,
    });
  });

  it('keeps Manual Entry preview and import item on the same matched activity input while retaining the selected factor id', () => {
    const preview = buildJsonActivityPreview({
      records: [
        {
          ...baseRecord,
          activityType: 'ELECTRICITY',
          province: 'Alberta',
          amount: 100,
          unit: 'kWh',
          date: '2026-07-20',
          startDate: undefined,
          endDate: undefined,
        },
      ],
      factors: manualEntryElectricityFactors,
    });

    expect(preview.records[0].matchedFactor?.id).toBe('electricity-ab-2025');
    expect(preview.importItems[0]).toMatchObject({
      activityType: ActivityType.ELECTRICITY,
      jurisdictionRegion: 'Alberta',
      recordYear: 2026,
      quantity: 100,
      unit: 'kWh',
    });
  });

  it('classifies Electricity without province as Missing Province and Excluded', () => {
    const preview = buildJsonActivityPreview({
      records: [{ ...baseRecord, province: undefined }],
      factors: [electricityFactor],
    });

    expect(preview.records[0]).toMatchObject({
      matchedFactorStatus: 'Missing Province',
      reportTreatment: 'Excluded',
      canImport: false,
    });
  });

  it('classifies Manual Entry preview unsupported electricity province as Missing Factor', () => {
    const preview = buildJsonActivityPreview({
      records: [
        {
          ...baseRecord,
          activityType: 'ELECTRICITY',
          province: 'Quebec',
          amount: 100,
          unit: 'kWh',
          date: '2026-07-20',
          startDate: undefined,
          endDate: undefined,
        },
      ],
      factors: manualEntryElectricityFactors,
    });

    expect(preview.records[0]).toMatchObject({
      matchedFactorStatus: 'Missing Factor',
      reportTreatment: 'Excluded',
      canImport: false,
    });
    expect(preview.records[0].matchedFactor).toBeUndefined();
  });

  it('classifies Natural Gas as Scope 1', () => {
    const preview = buildJsonActivityPreview({
      records: [{ ...baseRecord, activityType: 'Natural Gas', amount: 50, unit: 'm3' }],
      factors: [naturalGasFactor],
    });

    expect(preview.records[0]).toMatchObject({
      activityType: 'Natural Gas',
      scope: 'Scope 1',
    });
  });

  it('classifies Business Travel - Flight as Scope 3', () => {
    const preview = buildJsonActivityPreview({
      records: [
        {
          ...baseRecord,
          activityType: 'Business Travel - Flight',
          amount: 800,
          unit: 'km',
        },
      ],
      factors: [flightFactor],
    });

    expect(preview.records[0]).toMatchObject({
      activityType: 'Business Travel - Flight',
      scope: 'Scope 3',
    });
  });

  it.each([
    'Ground Transport',
    'Business Travel - Ground Transport',
    'Taxi',
    'Rideshare',
    'Rental Car',
  ])('matches %s to the pilot Ground Transport factor', (activityType) => {
    const preview = buildJsonActivityPreview({
      records: [
        {
          ...baseRecord,
          activityType,
          amount: 100,
          unit: 'km',
          province: undefined,
          date: '2026-07-20',
        },
      ],
      factors: [groundTransportFactor],
    });

    expect(preview.records[0]).toMatchObject({
      activityType: 'Ground Transport',
      scope: 'Scope 3',
      matchedFactorStatus: 'Matched',
      estimatedEmissionsKgCO2e: 20,
      reportTreatment: 'Included',
      canImport: true,
    });
    expect(preview.records[0].importItem).toMatchObject({
      activityType: ActivityType.GROUND_TRANSPORT,
      quantity: 100,
      unit: 'km',
    });
  });

  it('marks Ground Transport non-km rows as Unit Mismatch', () => {
    const preview = buildJsonActivityPreview({
      records: [
        {
          ...baseRecord,
          activityType: 'Ground Transport',
          amount: 100,
          unit: 'miles',
          province: undefined,
        },
      ],
      factors: [groundTransportFactor],
    });

    expect(preview.records[0]).toMatchObject({
      activityType: 'Ground Transport',
      scope: 'Scope 3',
      matchedFactorStatus: 'Unit Mismatch',
      reportTreatment: 'Excluded',
      canImport: false,
    });
  });

  it('classifies Water Usage as Operational Metric and Tracked Only', () => {
    const preview = buildJsonActivityPreview({
      records: [{ ...baseRecord, activityType: 'Water Usage', amount: 12, unit: 'm3' }],
    });

    expect(preview.records[0]).toMatchObject({
      scope: 'Operational Metric',
      matchedFactorStatus: 'Not Emissions Factor Required',
      reportTreatment: 'Tracked Only',
      canImport: true,
    });
  });

  it('marks unsupported activity type as Missing Factor', () => {
    const preview = buildJsonActivityPreview({
      records: [{ ...baseRecord, activityType: 'Compost Magic' }],
    });

    expect(preview.records[0]).toMatchObject({
      activityType: 'Compost Magic',
      matchedFactorStatus: 'Missing Factor',
      reportTreatment: 'Excluded',
      canImport: false,
    });
    expect(preview.records[0].validationErrors).toContain(
      'Unsupported activity type: Compost Magic.',
    );
  });

  it('keeps invalid amount as a row-level validation error', () => {
    const preview = buildJsonActivityPreview({
      records: [{ ...baseRecord, amount: 'twelve' }],
      factors: [electricityFactor],
    });

    expect(preview.records[0].amount).toBeNull();
    expect(preview.records[0].validationErrors).toContain(
      'Amount must be a valid number.',
    );
    expect(preview.records[0].canImport).toBe(false);
  });

  it('keeps missing date as a row-level validation error', () => {
    const preview = buildJsonActivityPreview({
      records: [{ ...baseRecord, startDate: undefined, endDate: undefined }],
      factors: [electricityFactor],
    });

    expect(preview.records[0].validationErrors).toContain(
      'A date or startDate is required.',
    );
    expect(preview.records[0].canImport).toBe(false);
  });

  it('ignores unknown fields but preserves sourceFile and notes', () => {
    const preview = buildJsonActivityPreview({
      records: [
        {
          ...baseRecord,
          unknown: 'ignored',
          sourceFile: 'upload.json',
          notes: 'January invoice rollup',
        },
      ],
      factors: [electricityFactor],
    });

    expect(preview.records[0]).toMatchObject({
      sourceFile: 'upload.json',
      notes: 'January invoice rollup',
      validationErrors: [],
    });
  });

  it('only emits import items for records without blocking validation errors', () => {
    const preview = buildJsonActivityPreview({
      records: [
        baseRecord,
        { ...baseRecord, amount: 'not a number' },
        { ...baseRecord, activityType: 'Water Usage', amount: 10, unit: 'm3' },
      ],
      sourceFileName: 'demo.json',
      factors: [electricityFactor],
    });

    expect(preview.summary).toMatchObject({
      totalRows: 3,
      validRows: 2,
      invalidRows: 1,
      includedRows: 2,
      trackedOnlyRows: 1,
    });
    expect(preview.importItems).toHaveLength(2);
    expect(preview.importItems[0]).toMatchObject({
      activityType: ActivityType.ELECTRICITY,
      quantity: 12500,
      sourceType: RecordSourceType.IMPORT,
      sourceFileName: 'demo.json',
    });
    expect(preview.importItems[1]).toMatchObject({
      activityType: ActivityType.WATER,
    });
  });
});

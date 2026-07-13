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
  activityType: ActivityType.ELECTRICITY,
  unit: 'kWh',
  region: 'Alberta',
  country: 'Canada',
  sourceYear: 2026,
};

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

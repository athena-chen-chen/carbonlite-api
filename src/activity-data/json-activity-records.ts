import { BadRequestException } from '@nestjs/common';
import { ActivityType, Prisma, RecordSourceType } from '@prisma/client';
import { CreateActivityDataDto } from './dto/create-activity-data.dto';
import {
  normalizeJurisdictionCountry,
  normalizeJurisdictionRegion,
  normalizeUnit,
} from '../metrics/metrics.utils';

export type ExtractedScope =
  | 'Scope 1'
  | 'Scope 2'
  | 'Scope 3'
  | 'Operational Metric';

export type MatchedFactorStatus =
  | 'Matched'
  | 'Missing Province'
  | 'Missing Factor'
  | 'Unit Mismatch'
  | 'Not Emissions Factor Required';

export type ReportTreatment = 'Included' | 'Excluded' | 'Tracked Only';

export type JsonActivityPreviewRecord = {
  rowNumber: number;
  facilityName: string;
  serviceLocation: string;
  province?: string;
  activityType: string;
  amount: number | null;
  unit: string;
  startDate?: string;
  endDate?: string;
  date?: string;
  scope: ExtractedScope;
  matchedFactorStatus: MatchedFactorStatus;
  matchedFactor?: JsonActivityPreviewMatchedFactor;
  estimatedEmissionsKgCO2e?: number | null;
  estimatedEmissionsStatus?: 'Calculated' | 'Waiting for quantity';
  reportTreatment: ReportTreatment;
  sourceFile?: string;
  notes?: string;
  validationErrors: string[];
  canImport: boolean;
  importItem?: CreateActivityDataDto;
};

export type JsonActivityPreviewSummary = {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  includedRows: number;
  excludedRows: number;
  trackedOnlyRows: number;
};

export type JsonActivityPreviewResult = {
  records: JsonActivityPreviewRecord[];
  importItems: CreateActivityDataDto[];
  summary: JsonActivityPreviewSummary;
};

type FactorCandidate = {
  id?: string | null;
  name?: string | null;
  activityType?: ActivityType | null;
  unit?: string | null;
  inputUnit?: string | null;
  value?: number | string | Prisma.Decimal | null;
  factorValue?: number | string | Prisma.Decimal | null;
  resultUnit?: string | null;
  jurisdiction?: string | null;
  region?: string | null;
  country?: string | null;
  jurisdictionRegion?: string | null;
  jurisdictionCountry?: string | null;
  sourceYear?: number | null;
  factorYear?: number | null;
};

export type JsonActivityPreviewMatchedFactor = {
  id?: string | null;
  name?: string | null;
  factorValue: number | null;
  value: number | null;
  unit: string | null;
  resultUnit: string | null;
  sourceYear: number | null;
  jurisdictionRegion: string | null;
  jurisdictionCountry: string | null;
};

type RawActivityRecord = Record<string, unknown>;

const INVALID_JSON_MESSAGE =
  'Invalid JSON file. Please check the file format and try again.';
const MISSING_RECORDS_MESSAGE =
  'Unable to find activityRecords in this JSON file. Please upload a CarbonLite activity records JSON file.';

const ACTIVITY_DEFINITIONS: Record<
  string,
  {
    label: string;
    prismaType: ActivityType;
    scope: ExtractedScope;
    customTypeLabel?: string;
    trackedOnly?: boolean;
  }
> = {
  electricity: {
    label: 'Electricity',
    prismaType: ActivityType.ELECTRICITY,
    scope: 'Scope 2',
  },
  'natural gas': {
    label: 'Natural Gas',
    prismaType: ActivityType.NATURAL_GAS,
    scope: 'Scope 1',
  },
  gasoline: {
    label: 'Gasoline',
    prismaType: ActivityType.GASOLINE,
    scope: 'Scope 1',
  },
  diesel: {
    label: 'Diesel',
    prismaType: ActivityType.DIESEL,
    scope: 'Scope 1',
  },
  'business travel - flight': {
    label: 'Business Travel - Flight',
    prismaType: ActivityType.AIR_TRAVEL,
    scope: 'Scope 3',
  },
  'hotel stay': {
    label: 'Hotel Stay',
    prismaType: ActivityType.HOTEL,
    scope: 'Scope 3',
  },
  'ground transport - taxi/rideshare': {
    label: 'Ground Transport - Taxi/Rideshare',
    prismaType: ActivityType.GROUND_TRANSPORT,
    scope: 'Scope 3',
  },
  'ground transport': {
    label: 'Ground Transport',
    prismaType: ActivityType.GROUND_TRANSPORT,
    scope: 'Scope 3',
  },
  'business travel - ground transport': {
    label: 'Ground Transport',
    prismaType: ActivityType.GROUND_TRANSPORT,
    scope: 'Scope 3',
  },
  taxi: {
    label: 'Ground Transport',
    prismaType: ActivityType.GROUND_TRANSPORT,
    scope: 'Scope 3',
  },
  rideshare: {
    label: 'Ground Transport',
    prismaType: ActivityType.GROUND_TRANSPORT,
    scope: 'Scope 3',
  },
  'rental car': {
    label: 'Ground Transport',
    prismaType: ActivityType.GROUND_TRANSPORT,
    scope: 'Scope 3',
  },
  'water usage': {
    label: 'Water Usage',
    prismaType: ActivityType.WATER,
    scope: 'Operational Metric',
    trackedOnly: true,
  },
};

export function parseJsonActivityPayload(input: {
  jsonContent?: string;
  data?: unknown;
}): RawActivityRecord[] {
  let payload: unknown;

  if (input.jsonContent !== undefined) {
    try {
      payload = JSON.parse(input.jsonContent);
    } catch {
      throw new BadRequestException(INVALID_JSON_MESSAGE);
    }
  } else {
    payload = input.data;
  }

  if (Array.isArray(payload)) return assertRecordArray(payload);

  if (isRecord(payload) && Array.isArray(payload.activityRecords)) {
    return assertRecordArray(payload.activityRecords);
  }

  throw new BadRequestException(MISSING_RECORDS_MESSAGE);
}

export function buildJsonActivityPreview(input: {
  records: RawActivityRecord[];
  sourceFileName?: string;
  factors?: FactorCandidate[];
}): JsonActivityPreviewResult {
  const factors = input.factors ?? [];
  const previewRecords = input.records.map((record, index) =>
    normalizeJsonActivityRecord({
      record,
      rowNumber: index + 1,
      sourceFileName: input.sourceFileName,
      factors,
    }),
  );

  const importItems = previewRecords
    .map((record) => record.importItem)
    .filter((item): item is CreateActivityDataDto => Boolean(item));

  return {
    records: previewRecords,
    importItems,
    summary: {
      totalRows: previewRecords.length,
      validRows: previewRecords.filter((record) => record.canImport).length,
      invalidRows: previewRecords.filter((record) => !record.canImport).length,
      includedRows: previewRecords.filter((record) => record.reportTreatment === 'Included')
        .length,
      excludedRows: previewRecords.filter((record) => record.reportTreatment === 'Excluded')
        .length,
      trackedOnlyRows: previewRecords.filter(
        (record) => record.reportTreatment === 'Tracked Only',
      ).length,
    },
  };
}

function normalizeJsonActivityRecord(input: {
  record: RawActivityRecord;
  rowNumber: number;
  sourceFileName?: string;
  factors: FactorCandidate[];
}): JsonActivityPreviewRecord {
  const rawActivityType = readString(input.record.activityType);
  const definition = getActivityDefinition(rawActivityType);
  const facilityName = readString(input.record.facilityName);
  const serviceLocation = readString(input.record.serviceLocation);
  const province = normalizeProvince(
    readString(input.record.province) || readString(input.record.jurisdictionRegion),
  );
  const amount = normalizeAmount(input.record.amount ?? input.record.quantity);
  const unit = readString(input.record.unit);
  const startDate = readDate(input.record.startDate);
  const endDate = readDate(input.record.endDate);
  const date = readDate(input.record.date ?? input.record.recordDate);
  const notes = readString(input.record.notes) || undefined;
  const sourceFile =
    readString(input.record.sourceFile) ||
    readString(input.record.sourceFileName) ||
    input.sourceFileName ||
    undefined;
  const recordDate = date ?? startDate;
  const validationErrors = validateNormalizedFields({
    facilityName,
    serviceLocation,
    activityType: rawActivityType,
    definition,
    amount,
    unit,
    recordDate,
  });
  const factorMatch = findBestJsonPreviewFactorMatch({
    definition,
    province,
    unit,
    recordYear: recordDate ? new Date(recordDate).getUTCFullYear() : null,
    factors: input.factors,
  });
  const reportTreatment = treatmentForStatus(factorMatch.status);
  const estimatedEmissionsKgCO2e =
    amount !== null && factorMatch.factor?.factorValue !== null && factorMatch.factor?.factorValue !== undefined
      ? round(amount * factorMatch.factor.factorValue)
      : null;
  const canImport = validationErrors.length === 0 && reportTreatment !== 'Excluded';

  const preview: JsonActivityPreviewRecord = {
    rowNumber: input.rowNumber,
    facilityName,
    serviceLocation,
    ...(province ? { province } : {}),
    activityType: definition?.label ?? rawActivityType,
    amount,
    unit,
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    ...(date ? { date } : {}),
    scope: definition?.scope ?? 'Scope 3',
    matchedFactorStatus: factorMatch.status,
    ...(factorMatch.factor ? { matchedFactor: factorMatch.factor } : {}),
    ...(factorMatch.factor
      ? {
          estimatedEmissionsKgCO2e,
          estimatedEmissionsStatus:
            amount === null ? 'Waiting for quantity' : 'Calculated',
        }
      : {}),
    reportTreatment,
    ...(sourceFile ? { sourceFile } : {}),
    ...(notes ? { notes } : {}),
    validationErrors,
    canImport,
  };

  if (canImport && definition && amount !== null && recordDate) {
    preview.importItem = {
      activityType: definition.prismaType,
      customTypeLabel: definition.customTypeLabel,
      recordDate,
      dateEstimated: Boolean(startDate && endDate && !date),
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: province,
      recordYear: new Date(recordDate).getUTCFullYear(),
      periodStart: startDate,
      periodEnd: endDate,
      quantity: amount,
      unit,
      sourceType: RecordSourceType.IMPORT,
      sourceReference: sourceFile,
      sourceFileName: sourceFile,
      notes,
    };
  }

  return preview;
}

export function findBestJsonPreviewFactorMatch(input: {
  definition?: ReturnType<typeof getActivityDefinition>;
  province?: string;
  unit: string;
  recordYear: number | null;
  factors: FactorCandidate[];
}): { status: MatchedFactorStatus; factor: JsonActivityPreviewMatchedFactor | null } {
  if (!input.definition) return { status: 'Missing Factor', factor: null };
  if (input.definition.trackedOnly) {
    return { status: 'Not Emissions Factor Required', factor: null };
  }
  if (input.definition.prismaType === ActivityType.ELECTRICITY && !input.province) {
    return { status: 'Missing Province', factor: null };
  }

  const activityFactors = input.factors.filter(
    (factor) => factor.activityType === input.definition?.prismaType,
  );
  if (activityFactors.length === 0) return { status: 'Missing Factor', factor: null };

  const normalizedInputUnit = normalizeUnit(input.unit);
  const unitMatches = activityFactors.filter(
    (factor) => normalizeUnit(String(factor.unit ?? factor.inputUnit ?? '')) === normalizedInputUnit,
  );
  if (unitMatches.length === 0) return { status: 'Unit Mismatch', factor: null };

  const region = normalizeJurisdictionRegion(input.province);
  const country = normalizeJurisdictionCountry('Canada');
  const jurisdictionMatches = unitMatches.filter((factor) =>
    jurisdictionCompatible(input.definition?.prismaType, factor, region, country),
  );
  if (jurisdictionMatches.length === 0) {
    return { status: 'Missing Factor', factor: null };
  }

  const selectedFactor = selectFactorForRecordYear(
    jurisdictionMatches,
    input.recordYear,
  );

  return selectedFactor
    ? { status: 'Matched', factor: toMatchedFactor(selectedFactor) }
    : { status: 'Missing Factor', factor: null };
}

function validateNormalizedFields(input: {
  facilityName: string;
  serviceLocation: string;
  activityType: string;
  definition?: ReturnType<typeof getActivityDefinition>;
  amount: number | null;
  unit: string;
  recordDate?: string;
}) {
  const errors: string[] = [];

  if (!input.facilityName) errors.push('Facility is required.');
  if (!input.serviceLocation) errors.push('Service location is required.');
  if (!input.activityType) errors.push('Activity type is required.');
  if (!input.definition && input.activityType) {
    errors.push(`Unsupported activity type: ${input.activityType}.`);
  }
  if (input.amount === null) errors.push('Amount must be a valid number.');
  if (!input.unit) errors.push('Unit is required.');
  if (!input.recordDate) errors.push('A date or startDate is required.');

  return errors;
}

function treatmentForStatus(status: MatchedFactorStatus): ReportTreatment {
  if (status === 'Matched') return 'Included';
  if (status === 'Not Emissions Factor Required') return 'Tracked Only';
  return 'Excluded';
}

function getActivityDefinition(value: string) {
  const key = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return ACTIVITY_DEFINITIONS[key];
}

function assertRecordArray(items: unknown[]): RawActivityRecord[] {
  if (!items.every(isRecord)) {
    throw new BadRequestException(MISSING_RECORDS_MESSAGE);
  }

  return items;
}

function isRecord(value: unknown): value is RawActivityRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function readDate(value: unknown): string | undefined {
  const text = readString(value);
  if (!text) return undefined;

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return undefined;
  return text;
}

function normalizeProvince(value: string): string | undefined {
  return normalizeJurisdictionRegion(value) ?? undefined;
}

function normalizeAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.replace(/,/g, '').trim();
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function jurisdictionCompatible(
  activityType: ActivityType | undefined,
  factor: FactorCandidate,
  region: string | null,
  country: string | null,
) {
  if (activityType === ActivityType.ELECTRICITY) {
    return regionMatches(factor.jurisdictionRegion ?? factor.region ?? factor.jurisdiction, region);
  }

  const factorCountry = normalizeJurisdictionCountry(factor.jurisdictionCountry ?? factor.country);
  const factorRegion = normalizeJurisdictionRegion(
    factor.jurisdictionRegion ?? factor.region ?? factor.jurisdiction,
  );

  return (
    !factorCountry ||
    factorCountry === country ||
    factorRegion === 'Canada' ||
    !factorRegion ||
    regionMatches(factorRegion, region)
  );
}

function selectFactorForRecordYear(
  factors: FactorCandidate[],
  recordYear: number | null,
) {
  const withYears = factors
    .map((factor) => ({
      factor,
      year: Number(factor.sourceYear ?? factor.factorYear),
    }))
    .filter((item) => Number.isFinite(item.year));

  if (recordYear) {
    const exact = withYears
      .filter((item) => item.year === recordYear)
      .sort((a, b) => compareFactorCandidates(a.factor, b.factor))[0];
    if (exact) return exact.factor;

    const prior = withYears
      .filter((item) => item.year <= recordYear)
      .sort((a, b) => b.year - a.year || compareFactorCandidates(a.factor, b.factor))[0];
    if (prior) return prior.factor;

    return null;
  }

  const latest = withYears.sort(
    (a, b) => b.year - a.year || compareFactorCandidates(a.factor, b.factor),
  )[0];
  return latest?.factor ?? factors.sort(compareFactorCandidates)[0] ?? null;
}

function compareFactorCandidates(a: FactorCandidate, b: FactorCandidate) {
  return String(a.name ?? a.id ?? '').localeCompare(String(b.name ?? b.id ?? ''));
}

function toMatchedFactor(factor: FactorCandidate): JsonActivityPreviewMatchedFactor {
  const factorValue = normalizeFactorValue(factor.factorValue ?? factor.value);

  return {
    id: factor.id ?? null,
    name: factor.name ?? null,
    factorValue,
    value: factorValue,
    unit: factor.unit ?? factor.inputUnit ?? null,
    resultUnit: factor.resultUnit ?? null,
    sourceYear: factor.sourceYear ?? factor.factorYear ?? null,
    jurisdictionRegion:
      normalizeJurisdictionRegion(
        factor.jurisdictionRegion ?? factor.region ?? factor.jurisdiction,
      ) ?? null,
    jurisdictionCountry:
      normalizeJurisdictionCountry(factor.jurisdictionCountry ?? factor.country) ??
      null,
  };
}

function normalizeFactorValue(value: FactorCandidate['factorValue']) {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

function regionMatches(factorRegion?: string | null, recordRegion?: string | null) {
  const factor = normalizeJurisdictionRegion(factorRegion);
  const record = normalizeJurisdictionRegion(recordRegion);
  return Boolean(factor && record && factor === record);
}

export function toJsonPreviewFactorCandidates(input: {
  legacyFactors?: Array<{
    id?: string | null;
    name?: string | null;
    activityType: ActivityType | null;
    unit: string;
    factorValue?: number | string | Prisma.Decimal | null;
    resultUnit?: string | null;
    jurisdiction: string | null;
    region: string | null;
    country: string | null;
    sourceYear: number | null;
  }>;
  governedFactors?: Array<{
    id?: string | null;
    inputUnit: string;
    factorValue?: number | string | Prisma.Decimal | null;
    resultUnit?: string | null;
    jurisdictionRegion: string | null;
    jurisdictionCountry: string | null;
    factorYear: number | null;
    factor: { activityType: ActivityType };
  }>;
}): FactorCandidate[] {
  return [
    ...(input.legacyFactors ?? []).filter(
      (factor): factor is NonNullable<typeof factor> & { activityType: ActivityType } =>
        Boolean(factor.activityType),
    ),
    ...(input.governedFactors ?? []).map((factor) => ({
      id: factor.id,
      activityType: factor.factor.activityType,
      inputUnit: factor.inputUnit,
      factorValue: factor.factorValue,
      resultUnit: factor.resultUnit,
      jurisdictionRegion: factor.jurisdictionRegion,
      jurisdictionCountry: factor.jurisdictionCountry,
      factorYear: factor.factorYear,
    })),
  ];
}

export function coerceDecimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

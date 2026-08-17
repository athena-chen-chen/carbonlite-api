import { Injectable } from '@nestjs/common';
import {
  ActivityType,
  Prisma,
  PrismaClient,
  RecordSourceType,
  ReportStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export const GOLDEN_SAMPLE_DATASET_KEY = 'golden-sample-v0.1';
export const GOLDEN_SAMPLE_WORKSPACE_NAME = 'CarbonLite Sample Workspace';
export const GOLDEN_SAMPLE_SOURCE_FILE = 'Golden Test Data.xlsx';
export const GOLDEN_SAMPLE_REPORT_TITLE =
  'CarbonLite Pilot Sample Emissions Data Readiness Report';

type GoldenSampleClient = Prisma.TransactionClient | PrismaClient;
type GoldenSampleActivityRecord = Omit<
  Prisma.ActivityDataCreateManyInput,
  'organizationId'
>;

export type GoldenSampleSeedResult = {
  workspaceId: string;
  dataset: typeof GOLDEN_SAMPLE_DATASET_KEY;
  alreadySeeded: boolean;
  recordsSeeded: number;
  totalSampleRecords: number;
  includedGhgRecords: number;
  trackedOperationalMetrics: number;
  recordsRequiringReview: number;
  totalCalculatedEmissions: number;
  scope1: number;
  scope2: number;
  scope3: number;
  reportCreated: boolean;
};

export const GOLDEN_SAMPLE_RECORDS: GoldenSampleActivityRecord[] = [
  goldenSampleActivity({
    activityType: ActivityType.ELECTRICITY,
    quantity: 12500,
    unit: 'kWh',
    province: 'Alberta',
    emissions: 6625,
    factorName: 'Electricity - Alberta',
    factorValue: 0.53,
    factorUnit: 'kgCO2e/kWh',
    scope: 'SCOPE_2',
    note: 'Golden sample electricity record for Alberta.',
  }),
  goldenSampleActivity({
    activityType: ActivityType.ELECTRICITY,
    quantity: 100,
    unit: 'kWh',
    province: 'British Columbia',
    emissions: 2,
    factorName: 'Electricity - British Columbia',
    factorValue: 0.02,
    factorUnit: 'kgCO2e/kWh',
    scope: 'SCOPE_2',
    note: 'Golden sample electricity record for British Columbia.',
  }),
  goldenSampleActivity({
    activityType: ActivityType.ELECTRICITY,
    quantity: 1000,
    unit: 'kWh',
    province: 'Ontario',
    emissions: 120,
    factorName: 'Electricity - Ontario',
    factorValue: 0.12,
    factorUnit: 'kgCO2e/kWh',
    scope: 'SCOPE_2',
    note: 'Golden sample electricity record for Ontario.',
  }),
  goldenSampleActivity({
    activityType: ActivityType.NATURAL_GAS,
    quantity: 1000,
    unit: 'm3',
    emissions: 1890,
    factorName: 'Natural gas combustion',
    factorValue: 1.89,
    factorUnit: 'kgCO2e/m3',
    scope: 'SCOPE_1',
    note: 'Golden sample natural gas record.',
  }),
  goldenSampleActivity({
    activityType: ActivityType.GASOLINE,
    quantity: 500,
    unit: 'liters',
    emissions: 1155,
    factorName: 'Gasoline combustion',
    factorValue: 2.31,
    factorUnit: 'kgCO2e/liter',
    scope: 'SCOPE_1',
    note: 'Golden sample gasoline record.',
  }),
  goldenSampleActivity({
    activityType: ActivityType.DIESEL,
    quantity: 100,
    unit: 'liters',
    emissions: 268,
    factorName: 'Diesel combustion',
    factorValue: 2.68,
    factorUnit: 'kgCO2e/liter',
    scope: 'SCOPE_1',
    note: 'Golden sample diesel record.',
  }),
  goldenSampleActivity({
    activityType: ActivityType.AIR_TRAVEL,
    quantity: 5000,
    unit: 'km',
    recordYear: 2025,
    jurisdictionRegion: 'Canada (Generic)',
    emissions: 575,
    factorName: 'Air travel',
    factorValue: 0.115,
    factorUnit: 'kgCO2e/km',
    scope: 'SCOPE_3',
    note: 'Golden sample air travel record.',
  }),
  goldenSampleActivity({
    activityType: ActivityType.HOTEL,
    quantity: 10,
    unit: 'nights',
    emissions: 150,
    factorName: 'Hotel stays',
    factorValue: 15,
    factorUnit: 'kgCO2e/night',
    scope: 'SCOPE_3',
    note: 'Golden sample hotel stay record.',
  }),
  goldenSampleActivity({
    activityType: ActivityType.WATER,
    quantity: 100,
    unit: 'm3',
    emissions: 0,
    factorName: 'Water usage tracked only',
    factorValue: null,
    factorUnit: null,
    scope: 'TRACKED_METRIC',
    matchingStatus: 'TRACKED_ONLY',
    calculationStatus: 'TRACKED_ONLY',
    reportTreatment: 'TRACKED_ONLY',
    calculationMessage:
      'Water is tracked as an operational metric and excluded from GHG emissions totals unless a reviewed water emissions factor is provided.',
    note: 'Golden sample water record. Tracked only and excluded from GHG total.',
  }),
  goldenSampleActivity({
    activityType: ActivityType.ELECTRICITY,
    quantity: 50,
    unit: 'MWh',
    province: 'Alberta',
    emissions: 26500,
    factorName: 'Electricity - Alberta',
    factorValue: 0.53,
    factorUnit: 'kgCO2e/kWh',
    scope: 'SCOPE_2',
    calculationMessage:
      '50 MWh × 1,000 = 50,000 kWh; 50,000 kWh × 0.53 kgCO2e/kWh = 26,500 kgCO2e.',
    note: 'Golden sample electricity MWh record for Alberta.',
  }),
];

@Injectable()
export class GoldenSampleDataService {
  constructor(private readonly prisma: PrismaService) {}

  ensureGoldenSampleDataForWorkspace(
    workspaceId: string,
    options?: { force?: boolean; createdById?: string | null },
  ) {
    return ensureGoldenSampleDataForWorkspace(this.prisma, workspaceId, options);
  }
}

export async function ensureGoldenSampleDataForWorkspace(
  client: GoldenSampleClient,
  workspaceId: string,
  options: { force?: boolean; createdById?: string | null } = {},
): Promise<GoldenSampleSeedResult> {
  const sampleWhere = getGoldenSampleActivityWhere(workspaceId);
  const existingSampleCount = await client.activityData.count({
    where: sampleWhere,
  });

  const hasCompleteDataset =
    !options.force && existingSampleCount === GOLDEN_SAMPLE_RECORDS.length;
  let recordsSeeded = 0;

  if (!hasCompleteDataset) {
    if (existingSampleCount > 0 || options.force) {
      await client.activityData.deleteMany({ where: sampleWhere });
    }

    await client.activityData.createMany({
      data: GOLDEN_SAMPLE_RECORDS.map((record) => ({
        ...record,
        organizationId: workspaceId,
      })),
    });
    recordsSeeded = GOLDEN_SAMPLE_RECORDS.length;
  }

  const reportCreated = await ensureGoldenSampleReport(client, workspaceId, {
    createdById: options.createdById ?? null,
    force: options.force,
  });

  return {
    workspaceId,
    dataset: GOLDEN_SAMPLE_DATASET_KEY,
    alreadySeeded: hasCompleteDataset,
    recordsSeeded,
    totalSampleRecords: GOLDEN_SAMPLE_RECORDS.length,
    includedGhgRecords: 9,
    trackedOperationalMetrics: 1,
    recordsRequiringReview: 0,
    totalCalculatedEmissions: 37285,
    scope1: 3313,
    scope2: 33247,
    scope3: 725,
    reportCreated,
  };
}

export function getGoldenSampleActivityWhere(organizationId: string) {
  return {
    organizationId,
    sourceReference: GOLDEN_SAMPLE_SOURCE_FILE,
    sourceFileName: GOLDEN_SAMPLE_SOURCE_FILE,
  } satisfies Prisma.ActivityDataWhereInput;
}

async function ensureGoldenSampleReport(
  client: GoldenSampleClient,
  organizationId: string,
  options: { createdById: string | null; force?: boolean },
) {
  const where = {
    organizationId,
    title: GOLDEN_SAMPLE_REPORT_TITLE,
  };

  if (options.force) {
    await client.report.deleteMany({ where });
  }

  const existingReportCount = await client.report.count({ where });
  if (existingReportCount > 0) return false;

  await client.report.create({
    data: {
      organizationId,
      createdById: options.createdById,
      title: GOLDEN_SAMPLE_REPORT_TITLE,
      reportingYear: 2026,
      periodStart: new Date('2026-07-01T00:00:00.000Z'),
      periodEnd: new Date('2026-07-31T00:00:00.000Z'),
      status: ReportStatus.GENERATED,
      summary:
        'Sample pilot report generated from the CarbonLite golden test dataset. Total calculated emissions: 37,285 kgCO2e.',
      contentMarkdown: [
        '# CarbonLite Pilot Sample Emissions Data Readiness Report',
        '',
        'Sample data only. Not for formal reporting.',
        '',
        '- Total calculated emissions: 37,285 kgCO2e',
        '- Scope 1: 3,313 kgCO2e',
        '- Scope 2: 33,247 kgCO2e',
        '- Scope 3: 725 kgCO2e',
        '- Included GHG records: 9',
        '- Tracked operational metrics: 1',
        '- Records requiring review: 0',
      ].join('\n'),
    },
  });

  return true;
}

function goldenSampleActivity(input: {
  activityType: ActivityType;
  quantity: number;
  unit: string;
  recordYear?: number;
  jurisdictionRegion?: string;
  emissions: number;
  factorName: string;
  factorValue: number | null;
  factorUnit: string | null;
  scope: string;
  province?: string;
  matchingStatus?: string;
  calculationStatus?: string;
  reportTreatment?: string;
  calculationMessage?: string;
  note: string;
}): GoldenSampleActivityRecord {
  const province = input.province ?? input.jurisdictionRegion ?? null;
  const isTrackedOnly = input.reportTreatment === 'TRACKED_ONLY';

  return {
    activityType: input.activityType,
    recordDate: new Date('2026-07-20T00:00:00.000Z'),
    recordYear: input.recordYear ?? 2026,
    jurisdictionCountry: 'Canada',
    jurisdictionRegion: province,
    quantity: input.quantity,
    unit: input.unit,
    sourceType: RecordSourceType.IMPORT,
    sourceReference: GOLDEN_SAMPLE_SOURCE_FILE,
    sourceFileName: GOLDEN_SAMPLE_SOURCE_FILE,
    notes: `${input.note} Dataset: ${GOLDEN_SAMPLE_DATASET_KEY}.`,
    matchingStatus: input.matchingStatus ?? 'MATCHED',
    reportTreatment: input.reportTreatment ?? 'INCLUDED',
    scope: input.scope,
    matchedFactorName: input.factorName,
    matchedFactorSourceYear: isTrackedOnly ? null : 2025,
    matchedFactorValue: input.factorValue,
    matchedFactorUnit: input.factorUnit,
    matchedFactorVersion: isTrackedOnly ? null : 'v1.0',
    matchedFactorSourceAuthority: isTrackedOnly
      ? 'CarbonLite Pilot Methodology'
      : 'CarbonLite System Defaults',
    matchedFactorSourceDocument: isTrackedOnly
      ? 'Water tracked-only methodology'
      : 'CarbonLite MVP Default Factors v1.0',
    matchedFactorVerificationStatus: 'Internal Review Required',
    matchedFactorConfidenceLevel: isTrackedOnly
      ? 'Not applicable'
      : input.scope === 'SCOPE_3' || input.scope === 'SCOPE_1'
        ? 'Medium (Engineering Estimate)'
        : 'Pilot Estimate',
    matchedFactorAssumptions:
      input.scope === 'SCOPE_3'
        ? 'Consultant Review Recommended'
        : null,
    calculatedEmissionsKgCO2e: input.emissions,
    calculationStatus: input.calculationStatus ?? 'CALCULATED',
    calculationMessage:
      input.calculationMessage ??
      `${input.quantity} ${input.unit} matched to ${input.factorName}.`,
  };
}

import { Injectable } from '@nestjs/common';
import {
  ActivityData,
  ConversionFactor,
  Organization,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CalculationSummaryQueryDto } from './dto/calculation-summary-query.dto';
import { normalizeUnit } from './metrics.utils';

export type CalculationStatus =
  | 'CALCULATED'
  | 'MISSING_FACTOR'
  | 'INVALID_QUANTITY'
  | 'INVALID_UNIT'
  | 'OUTSIDE_SCOPE';

type ActivityWithDocument = ActivityData & {
  document: { id: string; fileName: string } | null;
};

type FactorMatch = {
  factor: ConversionFactor;
  priority:
    | 'ORGANIZATION_CUSTOM'
    | 'VERIFIED_SYSTEM'
    | 'UNVERIFIED_SYSTEM';
};

@Injectable()
export class CalculationQualityService {
  constructor(private readonly prisma: PrismaService) {}

  async buildSummary(
    organizationId: string,
    query: CalculationSummaryQueryDto = {},
  ) {
    const [organization, records, factors] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
      }),
      this.prisma.activityData.findMany({
        where: { organizationId },
        include: {
          document: {
            select: { id: true, fileName: true },
          },
        },
        orderBy: { recordDate: 'asc' },
      }),
      this.prisma.conversionFactor.findMany({
        where: {
          type: 'EMISSION',
          OR: [{ organizationId }, { isSystemDefault: true }],
        },
        orderBy: [
          { isSystemDefault: 'asc' },
          { verified: 'desc' },
          { isDefault: 'desc' },
          { updatedAt: 'desc' },
        ],
      }),
    ]);

    return this.evaluate({
      organization,
      records,
      factors,
      query,
    });
  }

  evaluate(input: {
    organization: Pick<
      Organization,
      'id' | 'provinceState' | 'country'
    >;
    records: ActivityWithDocument[];
    factors: ConversionFactor[];
    query?: CalculationSummaryQueryDto;
  }) {
    const query = input.query ?? {};
    const selectedRecordIds = parseIds(query.selectedActivityRecordIds);
    const selectedDocumentIds = parseIds(query.selectedDocumentIds);
    const selectedRecordSet = new Set(selectedRecordIds);
    const selectedDocumentSet = new Set(selectedDocumentIds);
    const hasRecordScope = selectedRecordSet.size > 0;
    const hasDocumentScope = !hasRecordScope && selectedDocumentSet.size > 0;
    const organizationJurisdiction = formatJurisdiction(
      input.organization.provinceState,
      input.organization.country,
    );
    const calculationDetails = input.records.map((record) => {
      const reportingYear = record.recordDate.getUTCFullYear();
      const inScope = this.isInScope(record, {
        periodStart: query.periodStart,
        periodEnd: query.periodEnd,
        selectedRecordSet,
        selectedDocumentSet,
        hasRecordScope,
        hasDocumentScope,
      });

      if (!inScope) {
        return this.detail(record, {
          reportingYear,
          jurisdiction: organizationJurisdiction,
          status: 'OUTSIDE_SCOPE',
          reason: 'Record is outside the selected date range or report scope.',
        });
      }

      const quantity = Number(record.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return this.detail(record, {
          reportingYear,
          jurisdiction: organizationJurisdiction,
          status: 'INVALID_QUANTITY',
          reason: 'Quantity must be a positive number.',
        });
      }

      if (!record.unit?.trim() || !normalizeUnit(record.unit)) {
        return this.detail(record, {
          reportingYear,
          jurisdiction: organizationJurisdiction,
          status: 'INVALID_UNIT',
          reason: 'A valid activity unit is required.',
        });
      }

      const match = this.matchFactor({
        record,
        factors: input.factors,
        organizationId: input.organization.id,
        jurisdiction: organizationJurisdiction,
        reportingYear,
      });

      if (!match) {
        return this.detail(record, {
          reportingYear,
          jurisdiction: organizationJurisdiction,
          status: 'MISSING_FACTOR',
          reason: 'No conversion factor matched the activity type, unit, jurisdiction, and reporting year.',
          availableUnitsForActivityType: this.availableUnits(
            record,
            input.factors,
          ),
        });
      }

      const emissions = round(quantity * Number(match.factor.factorValue));
      return this.detail(record, {
        reportingYear,
        jurisdiction: organizationJurisdiction,
        status: 'CALCULATED',
        reason: null,
        emissions,
        factor: match.factor,
        factorPriority: match.priority,
      });
    });

    const inScopeDetails = calculationDetails.filter(
      (detail) => detail.status !== 'OUTSIDE_SCOPE',
    );
    const calculatedDetails = inScopeDetails.filter(
      (detail) => detail.status === 'CALCULATED',
    );
    const missingFactors = inScopeDetails
      .filter((detail) => detail.status === 'MISSING_FACTOR')
      .map((detail) => ({
        activityDataId: detail.activityDataId,
        activityType: detail.activityType,
        unit: detail.activityUnit,
        availableUnitsForActivityType:
          detail.availableUnitsForActivityType ?? [],
      }));
    const invalidRecordCount = inScopeDetails.filter((detail) =>
      ['INVALID_QUANTITY', 'INVALID_UNIT'].includes(detail.status),
    ).length;
    const skippedRecords = calculationDetails.length - calculatedDetails.length;
    const totalEstimatedEmissionsKgCO2e = round(
      calculatedDetails.reduce(
        (total, detail) => total + (detail.calculatedEmissionsKgCO2e ?? 0),
        0,
      ),
    );
    const usageTotals = buildUsageTotals(inScopeDetails);
    const conversionFactorsUsed = uniqueFactors(calculatedDetails);

    return {
      totalEstimatedEmissionsKgCO2e,
      totalRecordsFound: input.records.length,
      recordsInScope: inScopeDetails.length,
      recordsCalculated: calculatedDetails.length,
      recordsIncluded: calculatedDetails.length,
      processedRecords: calculatedDetails.length,
      skippedRecords,
      missingFactorCount: missingFactors.length,
      missingFactorRecords: missingFactors.length,
      invalidRecordCount,
      dataQualityCoverage:
        calculationDetails.length > 0
          ? round(
              (calculatedDetails.length / calculationDetails.length) * 100,
            )
          : 0,
      skippedReasons: {
        missingFactor: missingFactors.length,
        invalidQuantity: inScopeDetails.filter(
          (detail) => detail.status === 'INVALID_QUANTITY',
        ).length,
        invalidUnit: inScopeDetails.filter(
          (detail) => detail.status === 'INVALID_UNIT',
        ).length,
        outsideScope:
          hasRecordScope || hasDocumentScope
            ? calculationDetails.filter(
                (detail) => detail.status === 'OUTSIDE_SCOPE',
              ).length
            : 0,
        outsideDateRange: hasRecordScope || hasDocumentScope
          ? 0
          : calculationDetails.filter(
              (detail) => detail.status === 'OUTSIDE_SCOPE',
            ).length,
        invalidData: invalidRecordCount,
      },
      usageTotals,
      missingFactors,
      calculationDetails,
      matchedActivityEmissions: calculatedDetails.map((detail) => ({
        activityDataId: detail.activityDataId,
        activityType: detail.activityType,
        quantity: detail.activityQuantity,
        unit: detail.activityUnit,
        estimatedEmissionsKgCO2e: detail.calculatedEmissionsKgCO2e,
        sourceType: detail.sourceType,
        sourceReference: detail.sourceReference,
        notes: detail.notes,
        factorId: detail.factorId,
      })),
      conversionFactorsUsed,
      activities: inScopeDetails.map((detail) => ({
        id: detail.activityDataId,
        activityType: detail.activityType,
        recordDate: detail.recordDate,
        quantity: detail.activityQuantity,
        unit: detail.activityUnit,
        sourceType: detail.sourceType,
        sourceReference: detail.sourceReference,
        notes: detail.notes,
        sourceDocumentId: detail.sourceDocumentId,
        sourceFileName: detail.sourceFileName,
      })),
      totalsByMetric: [
        {
          metricType: 'CARBON_EMISSION',
          unit: 'kgCO2e',
          totalValue: String(totalEstimatedEmissionsKgCO2e),
          count: calculatedDetails.length,
        },
      ],
      totalsByFacility: [],
    };
  }

  private isInScope(
    record: ActivityWithDocument,
    scope: {
      periodStart?: string;
      periodEnd?: string;
      selectedRecordSet: Set<string>;
      selectedDocumentSet: Set<string>;
      hasRecordScope: boolean;
      hasDocumentScope: boolean;
    },
  ) {
    if (scope.hasRecordScope) return scope.selectedRecordSet.has(record.id);
    if (scope.hasDocumentScope) {
      const documentId = record.sourceDocumentId || record.documentId;
      return Boolean(documentId && scope.selectedDocumentSet.has(documentId));
    }

    const date = toDateOnly(record.recordDate);
    if (scope.periodStart && date < scope.periodStart) return false;
    if (scope.periodEnd && date > scope.periodEnd) return false;
    return true;
  }

  private matchFactor(input: {
    record: ActivityData;
    factors: ConversionFactor[];
    organizationId: string;
    jurisdiction: string;
    reportingYear: number;
  }): FactorMatch | null {
    const candidates = input.factors.filter((factor) => {
      if (factor.activityType !== input.record.activityType) return false;
      if (normalizeUnit(factor.unit) !== normalizeUnit(input.record.unit)) {
        return false;
      }
      if (
        factor.jurisdiction &&
        !jurisdictionMatches(factor.jurisdiction, input.jurisdiction)
      ) {
        return false;
      }
      if (factor.sourceYear && factor.sourceYear !== input.reportingYear) {
        return false;
      }
      return Number.isFinite(Number(factor.factorValue));
    });

    const custom = candidates.find(
      (factor) => factor.organizationId === input.organizationId,
    );
    if (custom) {
      return { factor: custom, priority: 'ORGANIZATION_CUSTOM' };
    }

    const verifiedSystem = candidates.find(
      (factor) => factor.isSystemDefault && factor.verified,
    );
    if (verifiedSystem) {
      return { factor: verifiedSystem, priority: 'VERIFIED_SYSTEM' };
    }

    const unverifiedSystem = candidates.find(
      (factor) => factor.isSystemDefault,
    );
    return unverifiedSystem
      ? { factor: unverifiedSystem, priority: 'UNVERIFIED_SYSTEM' }
      : null;
  }

  private availableUnits(
    record: ActivityData,
    factors: ConversionFactor[],
  ) {
    return Array.from(
      new Set(
        factors
          .filter(
            (factor) =>
              factor.activityType === record.activityType &&
              normalizeUnit(factor.unit) !== normalizeUnit(record.unit),
          )
          .map((factor) => factor.unit),
      ),
    ).sort();
  }

  detail(
    record: ActivityWithDocument,
    result: {
      reportingYear: number;
      jurisdiction: string;
      status: CalculationStatus;
      reason: string | null;
      emissions?: number;
      factor?: ConversionFactor;
      factorPriority?: FactorMatch['priority'];
      availableUnitsForActivityType?: string[];
    },
  ) {
    const factor = result.factor;
    return {
      activityDataId: record.id,
      activityType: record.activityType,
      recordDate: record.recordDate.toISOString(),
      dateEstimated: record.dateEstimated,
      reportingYear: result.reportingYear,
      jurisdiction: result.jurisdiction || 'Not specified',
      activityQuantity: Number(record.quantity),
      activityUnit: record.unit,
      factorId: factor?.id ?? null,
      factorName: factor?.name ?? null,
      factorValue: factor ? Number(factor.factorValue) : null,
      factorInputUnit: factor?.unit ?? null,
      factorResultUnit: factor?.resultUnit ?? null,
      factorPriority: result.factorPriority ?? null,
      factorSource:
        factor?.sourceAuthority || factor?.sourceName || 'Source not specified',
      sourceAuthority: factor?.sourceAuthority ?? null,
      sourceDocument: factor?.sourceDocument ?? null,
      sourceUrl: factor?.sourceUrl ?? null,
      sourceYear: factor?.sourceYear ?? null,
      factorVerified: factor?.verified ?? false,
      factorType: factor
        ? factor.isSystemDefault
          ? 'System'
          : 'Custom'
        : null,
      calculatedEmissionsKgCO2e: result.emissions ?? null,
      status: result.status,
      reason: result.reason,
      availableUnitsForActivityType:
        result.availableUnitsForActivityType ?? [],
      sourceType: record.sourceType,
      sourceReference: record.sourceReference,
      sourceFileName: record.sourceFileName || record.document?.fileName || null,
      sourceDocumentId: record.sourceDocumentId || record.documentId,
      notes: record.notes,
    };
  }
}

function parseIds(value?: string) {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeJurisdiction(value?: string | null) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function jurisdictionMatches(
  factorJurisdiction: string,
  recordJurisdiction: string,
) {
  const factor = normalizeJurisdiction(factorJurisdiction);
  const record = normalizeJurisdiction(recordJurisdiction);
  if (!factor) return true;
  if (factor === record) return true;

  const recordParts = record
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return recordParts.includes(factor);
}

function formatJurisdiction(
  provinceState?: string | null,
  country?: string | null,
) {
  return [provinceState, country].filter(Boolean).join(', ');
}

function toDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

function buildUsageTotals(details: Array<ReturnType<CalculationQualityService['detail']>>) {
  const fuelTypes = new Set(['DIESEL', 'GASOLINE', 'NATURAL_GAS', 'PROPANE']);
  const fuelUsageBreakdown = new Map<string, {
    activityType: string;
    unit: string;
    total: number;
  }>();
  let electricity = 0;

  details.forEach((detail) => {
    if (!['CALCULATED', 'MISSING_FACTOR'].includes(detail.status)) return;
    const quantity = Number(detail.activityQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return;

    if (fuelTypes.has(detail.activityType)) {
      const key = `${detail.activityType}:${normalizeUnit(detail.activityUnit)}`;
      const current = fuelUsageBreakdown.get(key) ?? {
        activityType: detail.activityType,
        unit: detail.activityUnit,
        total: 0,
      };
      current.total = round(current.total + quantity);
      fuelUsageBreakdown.set(key, current);
    }

    if (
      detail.activityType === 'ELECTRICITY' &&
      normalizeUnit(detail.activityUnit) === 'kwh'
    ) {
      electricity = round(electricity + quantity);
    }
  });

  return {
    fuel: Array.from(fuelUsageBreakdown.values()).reduce(
      (total, item) => round(total + item.total),
      0,
    ),
    electricity,
    fuelUnitLabel: 'Grouped by type and unit',
    electricityUnitLabel: 'kWh',
    fuelUsageBreakdown: Array.from(fuelUsageBreakdown.values()).sort((a, b) =>
      `${a.activityType}:${a.unit}`.localeCompare(`${b.activityType}:${b.unit}`),
    ),
  };
}

function uniqueFactors(
  details: Array<ReturnType<CalculationQualityService['detail']>>,
) {
  const factors = new Map<string, Record<string, unknown>>();
  details.forEach((detail) => {
    if (!detail.factorId || factors.has(detail.factorId)) return;
    factors.set(detail.factorId, {
      factorId: detail.factorId,
      activityType: detail.activityType,
      factorName: detail.factorName,
      factorValue: detail.factorValue,
      inputUnit: detail.factorInputUnit,
      resultUnit: detail.factorResultUnit,
      jurisdiction: detail.jurisdiction,
      reportingYear: detail.reportingYear,
      sourceAuthority: detail.sourceAuthority || detail.factorSource,
      sourceDocument: detail.sourceDocument,
      sourceUrl: detail.sourceUrl,
      sourceYear: detail.sourceYear,
      factorType: detail.factorType,
      verified: detail.factorVerified,
      priority: detail.factorPriority,
    });
  });
  return Array.from(factors.values());
}

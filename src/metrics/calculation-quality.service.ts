import { Injectable } from '@nestjs/common';
import {
  ActivityData,
  ConversionFactor,
  FactorVersion,
  Factor,
  FactorSource,
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
  | 'MISSING_DATA'
  | 'OUTSIDE_SCOPE';

type ActivityWithDocument = ActivityData & {
  document: { id: string; fileName: string } | null;
};

type GovernedFactorVersion = FactorVersion & {
  factor: Factor;
  source: FactorSource;
};

type FactorMatch = {
  factor?: ConversionFactor;
  governedVersion?: GovernedFactorVersion;
  priority:
    | 'ORGANIZATION_CUSTOM'
    | 'VERIFIED_SYSTEM'
    | 'GOVERNED_EXACT_PROVINCE_YEAR'
    | 'GOVERNED_COUNTRY_YEAR'
    | 'GOVERNED_PRIOR_YEAR'
    | 'DEMO_ALLOWED';
  matchingStatus: 'MATCHED' | 'MATCHED_PRIOR_YEAR';
  matchedBy: string;
  message: string;
};

@Injectable()
export class CalculationQualityService {
  constructor(private readonly prisma: PrismaService) {}

  async buildSummary(
    organizationId: string,
    query: CalculationSummaryQueryDto = {},
  ) {
    const [organization, records, factors, governedFactors] = await Promise.all([
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
      this.prisma.factorVersion.findMany({
        where: {
          factor: { isActive: true },
          status: { notIn: ['DEPRECATED', 'ARCHIVED'] },
        },
        include: { factor: true, source: true },
        orderBy: [{ factorYear: 'desc' }, { updatedAt: 'desc' }],
      }),
    ]);

    return this.evaluate({
      organization,
      records,
      factors,
      governedFactors,
      query,
    });
  }

  evaluate(input: {
    organization: Pick<
      Organization,
      | 'id'
      | 'provinceState'
      | 'country'
      | 'defaultReportingYear'
      | 'allowDemoFactorsForCalculations'
    >;
    records: ActivityWithDocument[];
    factors: ConversionFactor[];
    governedFactors?: GovernedFactorVersion[];
    query?: CalculationSummaryQueryDto;
  }) {
    const query = input.query ?? {};
    const selectedRecordIds = parseIds(query.selectedActivityRecordIds);
    const selectedDocumentIds = parseIds(query.selectedDocumentIds);
    const selectedRecordSet = new Set(selectedRecordIds);
    const selectedDocumentSet = new Set(selectedDocumentIds);
    const hasRecordScope = selectedRecordSet.size > 0;
    const hasDocumentScope = !hasRecordScope && selectedDocumentSet.size > 0;
    const calculationDetails = input.records.map((record) => {
      const recordYear = record.recordYear ?? record.recordDate.getUTCFullYear();
      const jurisdictionCountry = record.jurisdictionCountry || input.organization.country || null;
      const jurisdictionRegion = record.jurisdictionRegion || input.organization.provinceState || null;
      const organizationJurisdiction = formatJurisdiction(
        jurisdictionRegion,
        jurisdictionCountry,
      );
      const reportingYear = recordYear;
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

      if (!record.activityType) {
        return this.detail(record, {
          reportingYear,
          recordYear,
          jurisdictionCountry,
          jurisdictionRegion,
          jurisdiction: organizationJurisdiction,
          status: 'MISSING_DATA',
          reason: 'Activity type is required.',
        });
      }

      if (!record.unit?.trim() || !normalizeUnit(record.unit) || isNumericUnit(record.unit)) {
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
        governedFactors: input.governedFactors ?? [],
        organizationId: input.organization.id,
        allowDemoFactors: input.organization.allowDemoFactorsForCalculations,
        jurisdictionCountry,
        jurisdictionRegion,
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

      const factorValue = match.factor ? Number(match.factor.factorValue) : Number(match.governedVersion?.factorValue);
      const emissions = round(quantity * factorValue);
      return this.detail(record, {
        reportingYear,
        jurisdiction: organizationJurisdiction,
        status: 'CALCULATED',
        reason: null,
        emissions,
        factor: match.factor,
        governedVersion: match.governedVersion,
        factorPriority: match.priority,
        matchingStatus: match.matchingStatus,
        matchedBy: match.matchedBy,
        matchingMessage: match.message,
        recordYear,
        jurisdictionCountry,
        jurisdictionRegion,
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
        normalizedUnit: detail.normalizedUnit,
        estimatedEmissionsKgCO2e: detail.calculatedEmissionsKgCO2e,
        sourceType: detail.sourceType,
        sourceReference: detail.sourceReference,
        sourceDocumentId: detail.sourceDocumentId,
        sourceFileName: detail.sourceFileName,
        sourcePage: detail.sourcePage,
        sourceRow: detail.sourceRow,
        sourceTextSnippet: detail.sourceTextSnippet,
        notes: detail.notes,
        factorId: detail.factorId,
        factorVersionId: detail.factorVersionId,
        calculationFormula: detail.calculationFormula,
        matchingMethod: detail.matchedBy,
        matchingMessage: detail.matchingMessage,
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
        sourcePage: detail.sourcePage,
        sourceRow: detail.sourceRow,
        sourceTextSnippet: detail.sourceTextSnippet,
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
    governedFactors: GovernedFactorVersion[];
    organizationId: string;
    allowDemoFactors?: boolean | null;
    jurisdictionCountry?: string | null;
    jurisdictionRegion?: string | null;
    jurisdiction: string;
    reportingYear: number;
  }): FactorMatch | null {
    const normalizedInputUnit = normalizeUnit(input.record.unit);

    const legacyCandidates = input.factors.filter((factor) => {
      if (factor.activityType !== input.record.activityType) return false;
      if (normalizeUnit(factor.unit) !== normalizedInputUnit) return false;
      if (factor.sourceYear && factor.sourceYear !== input.reportingYear) return false;
      return Number.isFinite(Number(factor.factorValue));
    });

    const custom = legacyCandidates.find(
      (factor) =>
        factor.organizationId === input.organizationId &&
        factor.verified &&
        jurisdictionMatches(factor.jurisdiction || factor.region || factor.country, input.jurisdiction),
    );
    if (custom) {
      return {
        factor: custom,
        priority: 'ORGANIZATION_CUSTOM',
        matchingStatus: 'MATCHED',
        matchedBy: 'organization custom verified factor',
        message: `Matched organization custom verified factor for ${input.reportingYear}.`,
      };
    }

    const governedCandidates = input.governedFactors
      .filter((version) => version.factor.activityType === input.record.activityType)
      .filter((version) => normalizeUnit(version.inputUnit) === normalizedInputUnit)
      .filter((version) => Number.isFinite(Number(version.factorValue)))
      .filter((version) => version.source?.isActive !== false)
      .filter((version) =>
        ['VERIFIED', 'OFFICIAL'].includes(version.status) ||
        (input.allowDemoFactors && version.confidenceLevel === 'DEMO'),
      );

    const exactProvinceYear = governedCandidates
      .filter((version) => version.factorYear === input.reportingYear)
      .filter((version) => regionMatchesExactly(version.jurisdictionRegion, input.jurisdictionRegion))
      .filter((version) => countryMatches(version.jurisdictionCountry, input.jurisdictionCountry))
      .sort(compareGovernedFactorVersions)[0];
    if (exactProvinceYear) {
      return {
        governedVersion: exactProvinceYear,
        priority: exactProvinceYear.confidenceLevel === 'DEMO' ? 'DEMO_ALLOWED' : 'GOVERNED_EXACT_PROVINCE_YEAR',
        matchingStatus: 'MATCHED',
        matchedBy: 'exact province and year',
        message: `Matched: ${input.jurisdictionRegion || input.jurisdictionCountry || 'jurisdiction'} ${input.reportingYear} verified factor.`,
      };
    }

    const countryYear = governedCandidates
      .filter((version) => version.factorYear === input.reportingYear)
      .filter((version) => isCountryLevel(version.jurisdictionRegion, version.jurisdictionCountry))
      .filter((version) => countryMatches(version.jurisdictionCountry, input.jurisdictionCountry))
      .sort(compareGovernedFactorVersions)[0];
    if (countryYear) {
      return {
        governedVersion: countryYear,
        priority: countryYear.confidenceLevel === 'DEMO' ? 'DEMO_ALLOWED' : 'GOVERNED_COUNTRY_YEAR',
        matchingStatus: 'MATCHED',
        matchedBy: 'country-level fallback',
        message: `Matched country-level ${input.jurisdictionCountry || 'jurisdiction'} ${input.reportingYear} verified factor.`,
      };
    }

    const priorYear = governedCandidates
      .filter((version) => typeof version.factorYear === 'number' && version.factorYear < input.reportingYear)
      .filter((version) =>
        regionMatchesExactly(version.jurisdictionRegion, input.jurisdictionRegion) ||
        (isCountryLevel(version.jurisdictionRegion, version.jurisdictionCountry) &&
          countryMatches(version.jurisdictionCountry, input.jurisdictionCountry)),
      )
      .sort((a, b) => Number(b.factorYear ?? 0) - Number(a.factorYear ?? 0) || compareGovernedFactorVersions(a, b))[0];
    if (priorYear) {
      return {
        governedVersion: priorYear,
        priority: 'GOVERNED_PRIOR_YEAR',
        matchingStatus: 'MATCHED_PRIOR_YEAR',
        matchedBy: 'nearest prior year',
        message: `Using ${priorYear.factorYear} factor for ${input.reportingYear} record. Review recommended.`,
      };
    }

    const verifiedSystem = legacyCandidates.find(
      (factor) =>
        factor.isSystemDefault &&
        factor.verified &&
        jurisdictionMatches(factor.jurisdiction || factor.region || factor.country, input.jurisdiction),
    );
    if (verifiedSystem) {
      return {
        factor: verifiedSystem,
        priority: 'VERIFIED_SYSTEM',
        matchingStatus: 'MATCHED',
        matchedBy: 'legacy verified system factor',
        message: `Matched legacy verified system factor for ${input.reportingYear}.`,
      };
    }

    if (input.allowDemoFactors) {
      const demo = legacyCandidates.find((factor) => factor.isSystemDefault);
      if (demo) {
        return {
          factor: demo,
          priority: 'DEMO_ALLOWED',
          matchingStatus: 'MATCHED',
          matchedBy: 'demo factor allowed by organization setting',
          message: 'Using demo factor because organization setting allows demo factors for calculations.',
        };
      }
    }

    return null;
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
      governedVersion?: GovernedFactorVersion;
      factorPriority?: FactorMatch['priority'];
      matchingStatus?: FactorMatch['matchingStatus'];
      matchedBy?: string;
      matchingMessage?: string;
      recordYear?: number;
      jurisdictionCountry?: string | null;
      jurisdictionRegion?: string | null;
      availableUnitsForActivityType?: string[];
    },
  ) {
    const factor = result.factor;
    const governedVersion = result.governedVersion;
    const normalizedUnit = normalizeUnit(record.unit);
    const factorValue = factor ? Number(factor.factorValue) : governedVersion ? Number(governedVersion.factorValue) : null;
    const emissions = result.emissions ?? null;
    const calculationFormula =
      result.status === 'CALCULATED' && factorValue !== null && emissions !== null
        ? `${formatCalculationNumber(Number(record.quantity))} × ${formatCalculationNumber(factorValue)} = ${formatCalculationNumber(emissions)} kgCO2e`
        : null;
    return {
      activityDataId: record.id,
      activityType: record.activityType,
      recordDate: record.recordDate.toISOString(),
      dateEstimated: record.dateEstimated,
      reportingYear: result.reportingYear,
      recordYear: result.recordYear ?? result.reportingYear,
      jurisdiction: result.jurisdiction || 'Not specified',
      jurisdictionCountry: result.jurisdictionCountry ?? null,
      jurisdictionRegion: result.jurisdictionRegion ?? null,
      activityQuantity: Number(record.quantity),
      activityUnit: record.unit,
      quantityUnit: record.unit,
      normalizedUnit: normalizedUnit || null,
      factorId: factor?.id ?? governedVersion?.factorId ?? null,
      factorVersionId: governedVersion?.id ?? null,
      factorName: factor?.name ?? governedVersion?.factor.displayName ?? null,
      factorDisplayName: factor?.name ?? governedVersion?.factor.displayName ?? null,
      factorValue,
      factorInputUnit: factor?.unit ?? governedVersion?.inputUnit ?? null,
      factorResultUnit: factor?.resultUnit ?? governedVersion?.resultUnit ?? null,
      factorPriority: result.factorPriority ?? null,
      factorSource:
        factor?.sourceAuthority || factor?.sourceName || governedVersion?.source?.sourceAuthority || 'Source not specified',
      sourceAuthority: factor?.sourceAuthority ?? governedVersion?.source?.sourceAuthority ?? null,
      sourceDocument: factor?.sourceDocument ?? governedVersion?.source?.sourceDocument ?? null,
      sourceUrl: factor?.sourceUrl ?? governedVersion?.source?.sourceUrl ?? null,
      factorSourcePage: governedVersion?.sourcePage ?? governedVersion?.source?.sourcePage ?? null,
      factorSourceTable: governedVersion?.sourceTable ?? governedVersion?.source?.sourceTable ?? null,
      sourceYear: factor?.sourceYear ?? governedVersion?.source?.sourceYear ?? governedVersion?.factorYear ?? null,
      factorYear: governedVersion?.factorYear ?? factor?.sourceYear ?? null,
      factorJurisdictionCountry: governedVersion?.jurisdictionCountry ?? factor?.country ?? null,
      factorJurisdictionRegion: governedVersion?.jurisdictionRegion ?? factor?.region ?? factor?.jurisdiction ?? null,
      factorStatus: governedVersion?.status ?? (factor ? (factor.verified ? 'VERIFIED' : 'DRAFT') : null),
      factorVerified: factor?.verified ?? governedVersion?.verified ?? false,
      factorConfidenceLevel: governedVersion?.confidenceLevel ?? factor?.confidenceLevel ?? null,
      matchingStatus: result.matchingStatus ?? (result.status === 'CALCULATED' ? 'MATCHED' : result.status),
      matchedBy: result.matchedBy ?? null,
      matchingMessage: result.matchingMessage ?? result.reason,
      matchingMethod: result.matchedBy ?? null,
      factorType: factor
        ? factor.isSystemDefault
          ? 'System'
          : 'Custom'
        : governedVersion
          ? governedVersion.factor.isSystem
            ? 'System'
            : 'Custom'
          : null,
      calculatedEmission: emissions,
      calculatedEmissionsKgCO2e: emissions,
      calculationFormula,
      calculationStatus: result.status,
      status: result.status,
      reason: result.reason,
      availableUnitsForActivityType:
        result.availableUnitsForActivityType ?? [],
      sourceType: record.sourceType,
      sourceReference: record.sourceReference,
      sourceFileName: record.sourceFileName || record.document?.fileName || null,
      sourcePage: record.sourcePage,
      sourceRow: record.sourceRow,
      sourceTextSnippet: record.sourceTextSnippet,
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
  factorJurisdiction?: string | null,
  recordJurisdiction?: string | null,
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

function countryMatches(factorCountry?: string | null, recordCountry?: string | null) {
  const factor = normalizeJurisdiction(factorCountry);
  const record = normalizeJurisdiction(recordCountry);
  return !factor || !record || factor === record;
}

function regionMatchesExactly(factorRegion?: string | null, recordRegion?: string | null) {
  const factor = normalizeJurisdiction(factorRegion);
  const record = normalizeJurisdiction(recordRegion);
  if (!factor || !record) return false;
  return factor === record;
}

function isCountryLevel(factorRegion?: string | null, factorCountry?: string | null) {
  const region = normalizeJurisdiction(factorRegion);
  const country = normalizeJurisdiction(factorCountry);
  return !region || (!!country && region === country);
}

function compareGovernedFactorVersions(a: GovernedFactorVersion, b: GovernedFactorVersion) {
  const statusRank: Record<string, number> = { OFFICIAL: 4, VERIFIED: 3, DRAFT: 1 };
  const confidenceRank: Record<string, number> = {
    OFFICIAL_GOVERNMENT: 5,
    INDUSTRY_STANDARD: 4,
    CUSTOM: 3,
    ESTIMATED: 2,
    DEMO: 1,
  };
  const statusDiff = (statusRank[b.status] ?? 0) - (statusRank[a.status] ?? 0);
  if (statusDiff !== 0) return statusDiff;
  const confidenceDiff = (confidenceRank[b.confidenceLevel] ?? 0) - (confidenceRank[a.confidenceLevel] ?? 0);
  if (confidenceDiff !== 0) return confidenceDiff;
  return b.updatedAt.getTime() - a.updatedAt.getTime();
}

function isNumericUnit(unit?: string | null) {
  const value = String(unit ?? '').trim();
  return value !== '' && /^[-+]?\d+(\.\d+)?$/.test(value);
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

function formatCalculationNumber(value: number) {
  return Number.isInteger(value) ? String(value) : String(round(value));
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
    const key = detail.factorVersionId || detail.factorId;
    if (!key || factors.has(key)) {
      if (key && factors.has(key)) {
        const existing = factors.get(key);
        if (existing) {
          existing.usedRecordsCount = Number(existing.usedRecordsCount ?? 1) + 1;
        }
      }
      return;
    }
    factors.set(key, {
      factorId: detail.factorId,
      factorVersionId: detail.factorVersionId,
      activityType: detail.activityType,
      factorName: detail.factorName,
      factorValue: detail.factorValue,
      inputUnit: detail.factorInputUnit,
      resultUnit: detail.factorResultUnit,
      jurisdiction: detail.factorJurisdictionRegion
        ? formatJurisdiction(detail.factorJurisdictionRegion, detail.factorJurisdictionCountry)
        : detail.jurisdiction,
      reportingYear: detail.reportingYear,
      factorYear: detail.factorYear,
      factorStatus: detail.factorStatus,
      confidenceLevel: detail.factorConfidenceLevel,
      sourceAuthority: detail.sourceAuthority || detail.factorSource,
      sourceDocument: detail.sourceDocument,
      sourceUrl: detail.sourceUrl,
      sourcePage: detail.factorSourcePage,
      sourceTable: detail.factorSourceTable,
      sourceYear: detail.sourceYear,
      factorType: detail.factorType,
      verified: detail.factorVerified,
      priority: detail.factorPriority,
      matchingMethod: detail.matchedBy,
      matchingMessage: detail.matchingMessage,
      usedRecordsCount: 1,
    });
  });
  return Array.from(factors.values());
}

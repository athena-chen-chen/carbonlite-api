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
import {
  normalizeJurisdictionCountry,
  normalizeJurisdictionRegion,
  normalizeUnit,
} from './metrics.utils';

export type CalculationStatus =
  | 'CALCULATED'
  | 'MISSING_FACTOR'
  | 'INVALID_QUANTITY'
  | 'INVALID_UNIT'
  | 'MISSING_DATA'
  | 'MISSING_JURISDICTION'
  | 'TRACKED_ONLY'
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
      const jurisdictionCountry =
        normalizeJurisdictionCountry(record.jurisdictionCountry) ||
        normalizeJurisdictionCountry(input.organization.country) ||
        'Canada';
      const jurisdictionRegion =
        normalizeJurisdictionRegion(record.jurisdictionRegion) ||
        normalizeJurisdictionRegion(input.organization.provinceState);
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
          reason: 'Unit could not be normalized or matched to a supported factor unit.',
          matchedBy: 'INVALID_UNIT',
          matchingMessage: 'Unit could not be normalized or matched to a supported factor unit.',
        });
      }

      const normalizedUnit = normalizeUnit(record.unit);
      if (isUnsupportedActivityUnit(normalizedUnit)) {
        return this.detail(record, {
          reportingYear,
          jurisdiction: organizationJurisdiction,
          status: 'INVALID_UNIT',
          reason: 'Unit could not be normalized or matched to a supported factor unit.',
          matchedBy: 'INVALID_UNIT',
          matchingMessage: 'Unit could not be normalized or matched to a supported factor unit.',
        });
      }

      if (isTrackedOnlyActivity(record.activityType)) {
        return this.detail(record, {
          reportingYear,
          recordYear,
          jurisdictionCountry,
          jurisdictionRegion,
          jurisdiction: organizationJurisdiction,
          status: 'TRACKED_ONLY',
          reason:
            'Water usage is tracked for operational insight. Emissions are optional and require a reviewed water emissions factor.',
          matchedBy: 'TRACKED_ONLY',
          matchingMessage:
            'Water is treated as a tracked metric by default. Optional estimated emissions require a reviewed water factor.',
        });
      }

      if (record.activityType === 'ELECTRICITY' && !jurisdictionRegion) {
        return this.detail(record, {
          reportingYear,
          recordYear,
          jurisdictionCountry,
          jurisdictionRegion,
          jurisdiction: organizationJurisdiction,
          status: 'MISSING_JURISDICTION',
          reason:
            'Electricity factors are province-specific. Please provide a province or facility location.',
          matchedBy: 'NO_MATCH',
          matchingMessage:
            'Electricity factors are province-specific. Please provide a province or facility location.',
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
        const noMatchMessage = getNoMatchMessage({
          activityType: record.activityType,
          unit: normalizedUnit,
          jurisdictionRegion,
          reportingYear,
        });

        return this.detail(record, {
          reportingYear,
          jurisdiction: organizationJurisdiction,
          status: 'MISSING_FACTOR',
          reason: noMatchMessage,
          matchedBy: 'NO_MATCH',
          matchingMessage: noMatchMessage,
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
      .filter((detail) => ['MISSING_FACTOR', 'MISSING_JURISDICTION'].includes(detail.status))
      .map((detail) => ({
        activityDataId: detail.activityDataId,
        activityType: detail.activityType,
        unit: detail.activityUnit,
        availableUnitsForActivityType:
          detail.availableUnitsForActivityType ?? [],
      }));
    const invalidRecordCount = inScopeDetails.filter((detail) =>
      ['INVALID_QUANTITY', 'INVALID_UNIT', 'MISSING_JURISDICTION'].includes(detail.status),
    ).length;
    const trackedOnlyCount = inScopeDetails.filter(
      (detail) => detail.status === 'TRACKED_ONLY',
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
        trackedOnly: trackedOnlyCount,
      },
      calculationIssues: buildCalculationIssues(inScopeDetails),
      dataQualitySummary: buildDataQualitySummary(inScopeDetails),
      usageTotals,
      missingFactors,
      calculationDetails,
      records: calculationDetails.map((detail) => ({
        activityRecordId: detail.activityDataId,
        activityType: detail.activityType,
        quantity: detail.activityQuantity,
        unit: detail.activityUnit,
        normalizedQuantity: detail.activityQuantity,
        normalizedUnit: detail.normalizedUnit,
        recordDate: detail.recordDate,
        recordYear: detail.recordYear,
        facilityName: null,
        jurisdiction: detail.jurisdiction,
        calculationStatus: detail.explanationStatus,
        calculatedEmissions: detail.calculatedEmissionsKgCO2e,
        resultUnit: detail.factorResultUnit ?? 'kgCO2e',
        factor: detail.factorId || detail.factorVersionId
          ? {
              factorId: detail.factorId,
              factorVersionId: detail.factorVersionId,
              activityType: detail.activityType,
              factorValue: detail.factorValue,
              inputUnit: detail.factorInputUnit,
              resultUnit: detail.factorResultUnit,
              jurisdiction: detail.factorJurisdictionRegion
                ? formatJurisdiction(detail.factorJurisdictionRegion, detail.factorJurisdictionCountry)
                : detail.jurisdiction,
              factorYear: detail.factorYear,
              sourceAuthority: detail.sourceAuthority,
              sourceDocument: detail.sourceDocument,
              sourceYear: detail.sourceYear,
              sourceUrl: detail.sourceUrl,
              confidenceLevel: detail.factorConfidenceLevel,
              verificationStatus: detail.factorVerificationStatus,
              verified: detail.factorVerified,
              isSystem: detail.factorType === 'System',
              isOfficial: detail.factorStatus === 'OFFICIAL',
            }
          : null,
        matching: {
          matched: detail.status === 'CALCULATED',
          matchedBy: detail.explanationMatchedBy,
          message: detail.matchingMessage ?? detail.reason ?? '',
        },
        formula: detail.calculationFormula,
        warning: detail.status === 'CALCULATED' ? null : detail.reason,
      })),
      categoryBreakdown: buildCategoryBreakdown(inScopeDetails),
      hotspotSummary: buildHotspotSummary(inScopeDetails),
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
    const activityType = input.record.activityType;

    const legacyCandidates = input.factors.filter((factor) => {
      if (factor.activityType !== activityType) return false;
      if (normalizeUnit(factor.unit) !== normalizedInputUnit) return false;
      if (factor.sourceYear && factor.sourceYear !== input.reportingYear) return false;
      return Number.isFinite(Number(factor.factorValue));
    });

    const custom = legacyCandidates.find(
      (factor) =>
        factor.organizationId === input.organizationId &&
        factor.verified &&
        countryMatches(factor.country, input.jurisdictionCountry) &&
        regionCompatibleForActivity(activityType, factor.region || factor.jurisdiction, input.jurisdictionRegion),
    );
    if (custom) {
      return {
        factor: custom,
        priority: 'ORGANIZATION_CUSTOM',
        matchingStatus: 'MATCHED',
        matchedBy: 'ORGANIZATION_CUSTOM_EXACT',
        message: `Matched organization custom verified factor for ${formatActivityType(activityType)} / ${normalizedInputUnit}.`,
      };
    }

    const governedCandidates = input.governedFactors
      .filter((version) => version.factor.activityType === activityType)
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
        matchedBy: exactProvinceYear.factor.isSystem
          ? 'SYSTEM_EXACT_REGION_YEAR'
          : 'OFFICIAL_EXACT_REGION_YEAR',
        message:
          activityType === 'ELECTRICITY'
            ? `Matched ${input.jurisdictionRegion} electricity factor for ${input.reportingYear}.`
            : `Matched ${input.jurisdictionRegion || input.jurisdictionCountry || 'jurisdiction'} ${input.reportingYear} factor.`,
      };
    }

    const countryYear = governedCandidates
      .filter((version) => version.factorYear === input.reportingYear)
      .filter((version) => isCountryLevel(version.jurisdictionRegion, version.jurisdictionCountry))
      .filter((version) => countryMatches(version.jurisdictionCountry, input.jurisdictionCountry))
      .sort(compareGovernedFactorVersions)[0];
    if (countryYear && allowsCountryLevelFallback(activityType)) {
      return {
        governedVersion: countryYear,
        priority: countryYear.confidenceLevel === 'DEMO' ? 'DEMO_ALLOWED' : 'GOVERNED_COUNTRY_YEAR',
        matchingStatus: 'MATCHED',
        matchedBy: countryYear.factor.isSystem ? 'SYSTEM_COUNTRY_YEAR' : 'OFFICIAL_COUNTRY_YEAR',
        message: `Matched Canada-level factor for ${formatActivityType(activityType)} because no province-specific factor was required or available.`,
      };
    }

    const priorYear = governedCandidates
      .filter((version) => typeof version.factorYear === 'number' && version.factorYear < input.reportingYear)
      .filter((version) =>
        regionMatchesExactly(version.jurisdictionRegion, input.jurisdictionRegion) ||
        (allowsCountryLevelFallback(activityType) &&
          isCountryLevel(version.jurisdictionRegion, version.jurisdictionCountry) &&
          countryMatches(version.jurisdictionCountry, input.jurisdictionCountry)),
      )
      .sort((a, b) => Number(b.factorYear ?? 0) - Number(a.factorYear ?? 0) || compareGovernedFactorVersions(a, b))[0];
    if (priorYear) {
      return {
        governedVersion: priorYear,
        priority: 'GOVERNED_PRIOR_YEAR',
        matchingStatus: 'MATCHED_PRIOR_YEAR',
        matchedBy: 'PRIOR_YEAR',
        message: `Using nearest prior-year factor because no factor was found for the ${input.reportingYear} record year.`,
      };
    }

    const verifiedSystem = legacyCandidates.find(
      (factor) =>
        factor.isSystemDefault &&
        factor.verified &&
        countryMatches(factor.country, input.jurisdictionCountry) &&
        regionCompatibleForActivity(activityType, factor.region || factor.jurisdiction, input.jurisdictionRegion),
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

    const systemDefault = legacyCandidates.find((factor) => {
      if (!factor.isSystemDefault) return false;
      if (activityType === 'ELECTRICITY') {
        return regionMatchesExactly(factor.region || factor.jurisdiction, input.jurisdictionRegion);
      }

      return allowsCountryLevelFallback(activityType);
    });
    if (systemDefault) {
      return {
        factor: systemDefault,
        priority: systemDefault.confidenceLevel?.toUpperCase().includes('PLACEHOLDER')
          ? 'DEMO_ALLOWED'
          : 'VERIFIED_SYSTEM',
        matchingStatus: 'MATCHED',
        matchedBy: 'SYSTEM_DEFAULT',
        message:
          activityType === 'ELECTRICITY'
            ? `Matched ${input.jurisdictionRegion} electricity system factor.`
            : `Matched Canada-level factor for ${formatActivityType(activityType)} because no province-specific factor was required or available.`,
      };
    }

    if (input.allowDemoFactors) {
      const demo = legacyCandidates.find((factor) => {
        if (!factor.isSystemDefault) return false;
        if (activityType === 'ELECTRICITY') {
          return regionMatchesExactly(factor.region || factor.jurisdiction, input.jurisdictionRegion);
        }
        return allowsCountryLevelFallback(activityType);
      });
      if (demo) {
        return {
          factor: demo,
          priority: 'DEMO_ALLOWED',
          matchingStatus: 'MATCHED',
          matchedBy: 'PLACEHOLDER',
          message: 'Using placeholder factor because organization setting allows demo factors for calculations.',
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
        ? `${formatCalculationNumber(Number(record.quantity))} ${normalizedUnit} × ${formatCalculationNumber(factorValue)} ${(factor?.resultUnit ?? governedVersion?.resultUnit ?? 'kgCO2e')}/${factor?.unit ?? governedVersion?.inputUnit ?? normalizedUnit} = ${formatCalculationNumber(emissions)} kgCO2e`
        : null;
    const explanationStatus = mapExplanationStatus(result.status);
    const explanationMatchedBy = mapExplanationMatchedBy(result.matchedBy, result.status);

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
      factorVerificationStatus: governedVersion?.verificationStatus ?? factor?.verificationStatus ?? null,
      matchingStatus: result.matchingStatus ?? (result.status === 'CALCULATED' ? 'MATCHED' : result.status),
      matchedBy: result.matchedBy ?? null,
      matchingMessage: result.matchingMessage ?? result.reason,
      matchingMethod: result.matchedBy ?? null,
      explanationStatus,
      explanationMatchedBy,
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

function countryMatches(factorCountry?: string | null, recordCountry?: string | null) {
  const factor = normalizeJurisdictionCountry(factorCountry);
  const record = normalizeJurisdictionCountry(recordCountry);
  return !factor || !record || factor === record;
}

function regionMatchesExactly(factorRegion?: string | null, recordRegion?: string | null) {
  const factor = normalizeJurisdictionRegion(factorRegion);
  const record = normalizeJurisdictionRegion(recordRegion);
  if (!factor || !record) return false;
  return factor === record;
}

function regionCompatibleForActivity(
  activityType: string,
  factorRegion?: string | null,
  recordRegion?: string | null,
) {
  if (activityType === 'ELECTRICITY') {
    return regionMatchesExactly(factorRegion, recordRegion);
  }

  const normalizedFactorRegion = normalizeJurisdictionRegion(factorRegion);
  return (
    !normalizedFactorRegion ||
    normalizedFactorRegion === 'Canada' ||
    regionMatchesExactly(factorRegion, recordRegion)
  );
}

function isCountryLevel(factorRegion?: string | null, factorCountry?: string | null) {
  const region = normalizeJurisdictionRegion(factorRegion);
  const country = normalizeJurisdictionCountry(factorCountry);
  return !region || region === 'Canada' || (!!country && region === country);
}

function allowsCountryLevelFallback(activityType?: string | null) {
  return ['DIESEL', 'GASOLINE', 'NATURAL_GAS', 'HOTEL', 'PROPANE'].includes(
    String(activityType ?? '').toUpperCase(),
  );
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

function isUnsupportedActivityUnit(unit: string) {
  const supportedUnits = new Set([
    'liters',
    'm3',
    'kwh',
    'gj',
    'nights',
    'ton',
    'tonne',
    'ton-km',
    'km',
    'kg',
  ]);

  return !supportedUnits.has(unit);
}

function isTrackedOnlyActivity(activityType?: string | null) {
  return ['WATER', 'WASTE', 'WASTE_VOLUME'].includes(String(activityType ?? '').toUpperCase());
}

function getNoMatchMessage(input: {
  activityType?: string | null;
  unit: string;
  jurisdictionRegion?: string | null;
  reportingYear: number;
}) {
  const activityType = String(input.activityType ?? '');

  if (activityType === 'ELECTRICITY') {
    return `No electricity factor found for ${input.jurisdictionRegion || 'this jurisdiction'}, ${input.reportingYear}. Electricity factors must be jurisdiction-specific.`;
  }

  return `No conversion factor found for ${formatActivityType(activityType)} / ${input.unit}.`;
}

function formatActivityType(value?: string | null) {
  return String(value ?? 'Activity')
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function mapExplanationStatus(status: CalculationStatus) {
  const statuses: Record<CalculationStatus, string> = {
    CALCULATED: 'CALCULATED',
    MISSING_FACTOR: 'SKIPPED_MISSING_FACTOR',
    INVALID_QUANTITY: 'SKIPPED_MISSING_QUANTITY',
    INVALID_UNIT: 'SKIPPED_INVALID_UNIT',
    MISSING_DATA: 'SKIPPED_NEEDS_REVIEW',
    MISSING_JURISDICTION: 'SKIPPED_MISSING_JURISDICTION',
    TRACKED_ONLY: 'SKIPPED_TRACKED_ONLY',
    OUTSIDE_SCOPE: 'SKIPPED_NEEDS_REVIEW',
  };

  return statuses[status] ?? 'ERROR';
}

function mapExplanationMatchedBy(matchedBy?: string | null, status?: CalculationStatus) {
  if (matchedBy === 'SYSTEM_DEFAULT') return 'SYSTEM_DEFAULT';
  if (matchedBy === 'PLACEHOLDER') return 'PLACEHOLDER';
  if (matchedBy === 'TRACKED_ONLY') return 'TRACKED_ONLY';
  if (matchedBy === 'INVALID_UNIT') return 'INVALID_UNIT';
  if (matchedBy === 'NO_MATCH') return 'NO_MATCH';
  if (matchedBy === 'OFFICIAL_EXACT_REGION_YEAR' || matchedBy === 'SYSTEM_EXACT_REGION_YEAR') return 'EXACT';
  if (matchedBy === 'OFFICIAL_COUNTRY_YEAR' || matchedBy === 'SYSTEM_COUNTRY_YEAR') return 'COUNTRY_LEVEL';
  if (matchedBy === 'PRIOR_YEAR') return 'PRIOR_YEAR';
  if (status === 'CALCULATED') return 'EXACT';
  return 'NO_MATCH';
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

function buildCategoryBreakdown(details: Array<ReturnType<CalculationQualityService['detail']>>) {
  const categories = new Map<string, {
    activityType: string;
    emissions: number;
    recordCount: number;
    calculatedRecordCount: number;
    skippedRecordCount: number;
  }>();

  details.forEach((detail) => {
    const activityType = detail.activityType || 'UNKNOWN';
    const current = categories.get(activityType) ?? {
      activityType,
      emissions: 0,
      recordCount: 0,
      calculatedRecordCount: 0,
      skippedRecordCount: 0,
    };

    current.recordCount += 1;
    if (detail.status === 'CALCULATED') {
      current.calculatedRecordCount += 1;
      current.emissions = round(current.emissions + Number(detail.calculatedEmissionsKgCO2e ?? 0));
    } else {
      current.skippedRecordCount += 1;
    }

    categories.set(activityType, current);
  });

  return Array.from(categories.values()).sort((a, b) => a.activityType.localeCompare(b.activityType));
}

function buildCalculationIssues(details: Array<ReturnType<CalculationQualityService['detail']>>) {
  const issues = new Map<string, { issueType: string; count: number; message: string }>();

  details
    .filter((detail) => detail.status !== 'CALCULATED')
    .forEach((detail) => {
      const issueType = getIssueType(detail.status);
      const message = detail.matchingMessage || detail.reason || 'Review this record before calculation.';
      const key = `${issueType}:${message}`;
      const current = issues.get(key) ?? { issueType, count: 0, message };
      current.count += 1;
      issues.set(key, current);
    });

  return Array.from(issues.values());
}

function buildDataQualitySummary(details: Array<ReturnType<CalculationQualityService['detail']>>) {
  const totalRecords = details.length;
  const calculatedRecords = details.filter((detail) => detail.status === 'CALCULATED').length;
  const trackedOnlyCount = details.filter((detail) => detail.status === 'TRACKED_ONLY').length;
  const missingActivityTypeCount = details.filter((detail) => !String(detail.activityType ?? '').trim()).length;
  const missingQuantityCount = details.filter((detail) => {
    const quantity = Number(detail.activityQuantity);
    return !Number.isFinite(quantity) || quantity <= 0;
  }).length;
  const missingUnitCount = details.filter((detail) => !String(detail.activityUnit ?? '').trim()).length;
  const invalidUnitCount = details.filter((detail) => detail.status === 'INVALID_UNIT').length;
  const missingDateCount = details.filter((detail) => !detail.recordDate).length;
  const missingJurisdictionCount = details.filter((detail) => detail.status === 'MISSING_JURISDICTION').length;
  const missingFactorCount = details.filter((detail) => detail.status === 'MISSING_FACTOR').length;
  const sourceReferenceCount = details.filter((detail) =>
    Boolean(detail.sourceReference || detail.sourceFileName || detail.sourceDocumentId),
  ).length;
  const costDataCount = details.filter((detail) =>
    /(\bcost\b|\$|\bcad\b|\busd\b)/i.test(`${detail.notes ?? ''} ${detail.sourceTextSnippet ?? ''}`),
  ).length;
  const requiredCompleteCount = details.filter((detail) => {
    const quantity = Number(detail.activityQuantity);
    return Boolean(
      String(detail.activityType ?? '').trim() &&
        String(detail.activityUnit ?? '').trim() &&
        detail.recordDate &&
        Number.isFinite(quantity) &&
        quantity > 0 &&
        detail.status !== 'INVALID_UNIT',
    );
  }).length;
  const jurisdictionCompleteCount = details.filter((detail) => {
    if (detail.activityType === 'ELECTRICITY') {
      return Boolean(detail.jurisdictionRegion);
    }

    return Boolean(detail.jurisdictionCountry || detail.jurisdiction);
  }).length;
  const sourceReferenceCoverage = coverage(sourceReferenceCount, totalRecords);
  const costDataCoverage = coverage(costDataCount, totalRecords);
  const requiredFieldsScore = coverage(requiredCompleteCount, totalRecords);
  const factorCoverageScore = coverage(calculatedRecords, totalRecords);
  const jurisdictionScore = coverage(jurisdictionCompleteCount, totalRecords);
  const score = round(
    requiredFieldsScore * 0.4 +
      factorCoverageScore * 0.3 +
      jurisdictionScore * 0.15 +
      sourceReferenceCoverage * 0.1 +
      costDataCoverage * 0.05,
  );
  const readinessLevel =
    score >= 80 ? 'Good' : score >= 50 ? 'Needs Review' : 'Incomplete';

  return {
    totalRecords,
    recordsReadyForCalculation: calculatedRecords,
    recordsRequiringReview: Math.max(0, totalRecords - calculatedRecords),
    missingActivityTypeCount,
    missingQuantityCount,
    missingUnitCount,
    invalidUnitCount,
    missingDateCount,
    missingJurisdictionCount,
    missingFactorCount,
    trackedOnlyCount,
    sourceReferenceCoverage,
    costDataCoverage,
    dataReadinessScore: score,
    readinessLevel,
    message: dataReadinessMessage(readinessLevel, score),
    checklist: [
      {
        key: 'required-fields',
        label: 'Required fields completeness',
        passed: requiredFieldsScore >= 90,
        count: requiredCompleteCount,
        total: totalRecords,
        message:
          'Activity type, quantity, unit, and date are needed before emissions can be calculated.',
      },
      {
        key: 'factor-coverage',
        label: 'Factor match coverage',
        passed: factorCoverageScore >= 80,
        count: calculatedRecords,
        total: totalRecords,
        message:
          'Records need matching conversion factors to be included in emissions totals.',
      },
      {
        key: 'jurisdiction',
        label: 'Jurisdiction completeness',
        passed: jurisdictionScore >= 90,
        count: jurisdictionCompleteCount,
        total: totalRecords,
        message:
          'Province is required for electricity because electricity factors vary by province.',
      },
      {
        key: 'source-traceability',
        label: 'Source traceability',
        passed: sourceReferenceCoverage >= 80,
        count: sourceReferenceCount,
        total: totalRecords,
        message:
          'Source references help trace emissions results back to bills, invoices, spreadsheets, or manual notes.',
      },
      {
        key: 'cost-data',
        label: 'Cost data completeness',
        passed: costDataCoverage >= 50,
        count: costDataCount,
        total: totalRecords,
        message:
          'Cost is optional, but useful for later financial impact and prioritization analysis.',
      },
    ],
  };
}

function coverage(count: number, total: number) {
  if (total <= 0) return 0;
  return round((count / total) * 100);
}

function dataReadinessMessage(level: string, score: number) {
  if (level === 'Good') {
    return `Data readiness is ${formatCalculationNumber(score)}%. Most records are ready for calculation and traceability review.`;
  }
  if (level === 'Needs Review') {
    return `Data readiness is ${formatCalculationNumber(score)}%. Some records need missing fields, factors, jurisdiction, or source references before final reporting.`;
  }
  return 'Data readiness is incomplete. Add required fields, source references, and matching factors before relying on emissions results.';
}

function buildHotspotSummary(details: Array<ReturnType<CalculationQualityService['detail']>>) {
  const calculatedDetails = details.filter((detail) => detail.status === 'CALCULATED');
  const totalCalculatedEmissions = round(
    calculatedDetails.reduce(
      (total, detail) => total + Number(detail.calculatedEmissionsKgCO2e ?? 0),
      0,
    ),
  );
  const categoryTotals = new Map<string, {
    activityType: string;
    displayName: string;
    emissions: number;
    recordCount: number;
    calculatedRecordCount: number;
    excludedRecordCount: number;
  }>();

  details.forEach((detail) => {
    const activityType = detail.activityType || 'UNKNOWN';
    const current = categoryTotals.get(activityType) ?? {
      activityType,
      displayName: formatActivityType(activityType),
      emissions: 0,
      recordCount: 0,
      calculatedRecordCount: 0,
      excludedRecordCount: 0,
    };

    current.recordCount += 1;
    if (detail.status === 'CALCULATED') {
      current.calculatedRecordCount += 1;
      current.emissions = round(
        current.emissions + Number(detail.calculatedEmissionsKgCO2e ?? 0),
      );
    } else {
      current.excludedRecordCount += 1;
    }

    categoryTotals.set(activityType, current);
  });

  const categoryHotspots = Array.from(categoryTotals.values())
    .filter((row) => row.calculatedRecordCount > 0 && row.emissions > 0)
    .sort((a, b) => b.emissions - a.emissions)
    .map((row, index) => {
      const percentageOfTotal =
        totalCalculatedEmissions > 0
          ? round((row.emissions / totalCalculatedEmissions) * 100)
          : 0;

      return {
        ...row,
        percentageOfTotal,
        rank: index + 1,
        hotspotLevel: getHotspotLevel(percentageOfTotal),
        focusMessage: buildHotspotFocusMessage(row.displayName, percentageOfTotal),
      };
    });

  const excludedCategories = buildExcludedHotspotCategories(details);
  const topCategory = categoryHotspots[0]
    ? {
        activityType: categoryHotspots[0].activityType,
        emissions: categoryHotspots[0].emissions,
        percentageOfTotal: categoryHotspots[0].percentageOfTotal,
      }
    : null;

  return {
    totalCalculatedEmissions,
    emissionsUnit: 'kgCO2e',
    calculatedRecordCount: calculatedDetails.length,
    excludedRecordCount: details.length - calculatedDetails.length,
    totalRecordCount: details.length,
    topCategory,
    categoryHotspots,
    excludedCategories,
    focusRecommendations: buildHotspotRecommendations({
      categoryHotspots,
      excludedCategories,
      excludedRecordCount: details.length - calculatedDetails.length,
      totalCalculatedEmissions,
    }),
  };
}

function buildExcludedHotspotCategories(
  details: Array<ReturnType<CalculationQualityService['detail']>>,
) {
  const excluded = new Map<string, {
    activityType: string;
    displayName: string;
    excludedRecordCount: number;
    reason: string;
    message: string;
  }>();

  details
    .filter((detail) => detail.status !== 'CALCULATED')
    .forEach((detail) => {
      const activityType = detail.activityType || 'UNKNOWN';
      const reason = mapHotspotExcludedReason(detail.status);
      const key = `${activityType}:${reason}`;
      const current = excluded.get(key) ?? {
        activityType,
        displayName: formatActivityType(activityType),
        excludedRecordCount: 0,
        reason,
        message: hotspotExcludedMessage(reason, activityType),
      };

      current.excludedRecordCount += 1;
      excluded.set(key, current);
    });

  return Array.from(excluded.values()).sort((a, b) =>
    `${a.reason}:${a.displayName}`.localeCompare(`${b.reason}:${b.displayName}`),
  );
}

function getHotspotLevel(percentage: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (percentage >= 40) return 'HIGH';
  if (percentage >= 15) return 'MEDIUM';
  return 'LOW';
}

function buildHotspotFocusMessage(displayName: string, percentage: number) {
  if (percentage >= 40) {
    return `${displayName} contributes ${formatCalculationNumber(percentage)}% of calculated emissions. Review this hotspot first for reduction opportunities or data quality checks.`;
  }

  if (percentage >= 15) {
    return `${displayName} is a material contributor to calculated emissions and should be included in early review.`;
  }

  return `${displayName} is a lower-share calculated emissions category. Keep it visible, but prioritize larger hotspots first.`;
}

function buildHotspotRecommendations(input: {
  categoryHotspots: Array<{
    activityType: string;
    displayName: string;
    emissions: number;
    percentageOfTotal: number;
  }>;
  excludedCategories: Array<{
    reason: string;
    excludedRecordCount: number;
  }>;
  excludedRecordCount: number;
  totalCalculatedEmissions: number;
}) {
  const recommendations: Array<{
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
    title: string;
    message: string;
    relatedActivityType?: string;
  }> = [];
  const top = input.categoryHotspots[0];
  const second = input.categoryHotspots[1];

  if (!top || input.totalCalculatedEmissions <= 0) {
    recommendations.push({
      priority: 'HIGH',
      title: 'No calculated emissions available yet',
      message:
        'Hotspot analysis will be available once activity records can be calculated with valid units and matching conversion factors.',
    });
  } else if (top.percentageOfTotal >= 40) {
    recommendations.push({
      priority: 'HIGH',
      title: `Focus first on ${top.displayName}`,
      message: `${top.displayName} contributes ${formatCalculationNumber(top.percentageOfTotal)}% of calculated emissions. This is the largest hotspot and should be reviewed first for reduction opportunities or data quality checks.`,
      relatedActivityType: top.activityType,
    });
  }

  if (top && second && top.percentageOfTotal + second.percentageOfTotal >= 70) {
    const combined = round(top.percentageOfTotal + second.percentageOfTotal);
    recommendations.push({
      priority: 'MEDIUM',
      title: 'Most emissions are concentrated in a few categories',
      message: `The top two categories contribute ${formatCalculationNumber(combined)}% of calculated emissions. Focusing on these areas may provide the most useful first step.`,
    });
  }

  if (input.excludedRecordCount > 0) {
    recommendations.push({
      priority: 'MEDIUM',
      title: 'Improve data quality before making decisions',
      message: `${input.excludedRecordCount} records were excluded from emissions totals due to missing factors, invalid units, tracked-only metrics, or records requiring review.`,
    });
  }

  if (input.excludedCategories.some((item) => item.reason === 'TRACKED_ONLY')) {
    recommendations.push({
      priority: 'LOW',
      title: 'Water is tracked separately',
      message:
        'Water usage is currently tracked as an operational metric and is not included in emissions totals unless a reviewed water emissions factor is enabled.',
      relatedActivityType: 'WATER',
    });
  }

  if (input.excludedCategories.some((item) => item.reason === 'MISSING_FACTOR')) {
    recommendations.push({
      priority: 'MEDIUM',
      title: 'Some categories need conversion factors',
      message:
        'Some records could not be calculated because no matching conversion factor was available.',
    });
  }

  return recommendations.slice(0, 4);
}

function mapHotspotExcludedReason(status: CalculationStatus) {
  if (status === 'MISSING_FACTOR') return 'MISSING_FACTOR';
  if (status === 'INVALID_UNIT') return 'INVALID_UNIT';
  if (status === 'TRACKED_ONLY') return 'TRACKED_ONLY';
  if (status === 'MISSING_JURISDICTION') return 'MISSING_JURISDICTION';
  return 'NEEDS_REVIEW';
}

function hotspotExcludedMessage(reason: string, activityType: string) {
  const displayName = formatActivityType(activityType);
  if (reason === 'MISSING_FACTOR') {
    return `${displayName} records were excluded because no matching conversion factor was available.`;
  }
  if (reason === 'INVALID_UNIT') {
    return `${displayName} records were excluded because the unit could not be normalized or matched.`;
  }
  if (reason === 'TRACKED_ONLY') {
    return `${displayName} is tracked as an operational metric and excluded from emissions totals by default.`;
  }
  if (reason === 'MISSING_JURISDICTION') {
    return `${displayName} records were excluded because jurisdiction is required for factor matching.`;
  }
  return `${displayName} records require review before emissions can be calculated.`;
}

function getIssueType(status: CalculationStatus) {
  if (status === 'MISSING_FACTOR') return 'Missing Factor';
  if (status === 'INVALID_UNIT') return 'Invalid Unit';
  if (status === 'INVALID_QUANTITY') return 'Missing Quantity';
  if (status === 'TRACKED_ONLY') return 'Tracked Metric';
  if (status === 'MISSING_DATA') return 'Needs Review';
  return 'Needs Review';
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

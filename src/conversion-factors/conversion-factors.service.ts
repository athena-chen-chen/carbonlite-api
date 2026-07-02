import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ActivityType, FactorStatus, FactorType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateConversionFactorDto } from './dto/create-conversion-factor.dto';
import { UpdateConversionFactorDto } from './dto/update-conversion-factor.dto';
import { ConversionFactorQueryDto } from './dto/conversion-factor-query.dto';
import { CreateFactorVersionDto } from './dto/create-factor-version.dto';
import { UpdateFactorVersionDraftDto } from './dto/update-factor-version-draft.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ActivityTrackingService } from '../activity-tracking/activity-tracking.service';
import {
  normalizeJurisdictionCountry,
  normalizeJurisdictionRegion,
  normalizeUnit,
} from '../metrics/metrics.utils';

type ApplicableFactorInput = {
  activityType: string;
  quantity?: number | null;
  inputUnit: string;
  unit?: string | null;
  jurisdictionCountry?: string | null;
  jurisdictionRegion?: string | null;
  factorYear?: number | null;
  recordYear?: number | null;
  recordDate?: Date | string | null;
  allowDemoFactors?: boolean | null;
  allowPlaceholderFactors?: boolean | null;
  allowSystemFactors?: boolean | null;
  organizationId: string;
};

type FactorMatchResult = {
  factorValue: number;
  inputUnit: string;
  resultUnit: string;
  factorId?: string;
  factorVersionId?: string;
  displayName?: string;
  sourceAuthority?: string | null;
  sourceDocument?: string | null;
  sourceYear?: number | null;
  sourceUrl?: string | null;
  status?: string;
  confidenceLevel?: string;
  factorType: 'ORGANIZATION_CUSTOM' | 'GOVERNED_LIBRARY' | 'LEGACY_SYSTEM_DEFAULT';
  jurisdictionCountry?: string | null;
  jurisdictionRegion?: string | null;
  factorYear?: number | null;
};

type ApplicableFactor = Partial<FactorMatchResult> & {
  matched: boolean;
  factor: FactorMatchResult | null;
  status:
    | 'MATCHED'
    | 'MATCHED_COUNTRY_LEVEL'
    | 'MATCHED_SYSTEM_DEFAULT'
    | 'MATCHED_PRIOR_YEAR'
    | 'NO_MATCH'
    | 'INVALID_UNIT'
    | 'MISSING_JURISDICTION'
    | 'TRACKED_ONLY';
  matchedBy:
    | 'ORGANIZATION_CUSTOM_EXACT'
    | 'OFFICIAL_EXACT_REGION_YEAR'
    | 'OFFICIAL_COUNTRY_YEAR'
    | 'SYSTEM_EXACT_REGION_YEAR'
    | 'SYSTEM_COUNTRY_YEAR'
    | 'PRIOR_YEAR'
    | 'TRACKED_ONLY'
    | 'NO_MATCH'
    | 'INVALID_UNIT';
  message: string;
  warnings: string[];
};

type FactorReviewInput = {
  reviewedBy: string;
  reviewedAt?: Date;
  reviewNotes?: string;
  approvalSource?: string;
};

type FactorVersionWithGovernance = Awaited<
  ReturnType<ConversionFactorsService['findGovernedFactorVersion']>
>;

@Injectable()
export class ConversionFactorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly activityTracking: ActivityTrackingService,
  ) {}

  async verifyFactor(id: string, input: FactorReviewInput) {
    const reviewedAt = input.reviewedAt ?? new Date();
    const existing = await this.findGovernedFactorVersion(id);
    this.validateProductionReadiness(existing, {
      ...input,
      reviewedAt,
      status: 'VERIFIED',
    });

    await this.deprecatePreviousProductionVersions(existing);

    const updated = await this.prisma.factorVersion.update({
      where: { id },
      data: {
        verified: true,
        status: 'VERIFIED',
        reviewedBy: input.reviewedBy,
        reviewedAt,
        reviewNotes: input.reviewNotes ?? null,
        approvalSource: input.approvalSource ?? existing.source.sourceAuthority,
      },
      include: { factor: true, source: true },
    });

    await this.prisma.factorReviewLog.create({
      data: {
        factorVersionId: id,
        reviewedBy: input.reviewedBy,
        reviewStatus: 'APPROVED',
        reviewNotes: input.reviewNotes ?? null,
        reviewedAt,
      },
    });

    await this.logFactorVersionChange({
      factorId: existing.factorId,
      factorVersionId: id,
      action: 'VERSION_VERIFIED',
      oldFactorVersionId: existing.id,
      newFactorVersionId: updated.id,
      oldValue: existing,
      newValue: updated,
      reason: input.reviewNotes,
      changedBy: input.reviewedBy,
    });

    return updated;
  }

  async approveFactor(id: string, input: FactorReviewInput) {
    return this.verifyFactor(id, input);
  }

  async deprecateFactor(id: string, reason?: string, changedBy?: string) {
    const existing = await this.findGovernedFactorVersion(id);
    const updated = await this.prisma.factorVersion.update({
      where: { id },
      data: { status: 'DEPRECATED' },
      include: { factor: true, source: true },
    });

    await this.logFactorVersionChange({
      factorId: existing.factorId,
      factorVersionId: id,
      action: 'VERSION_DEPRECATED',
      oldFactorVersionId: existing.id,
      newFactorVersionId: updated.id,
      oldValue: existing,
      newValue: updated,
      reason,
      changedBy,
    });

    return updated;
  }

  async archiveFactor(id: string, reason?: string, changedBy?: string) {
    const existing = await this.findGovernedFactorVersion(id);
    const replacement = await this.prisma.factorVersion.findFirst({
      where: {
        id: { not: id },
        factorId: existing.factorId,
        inputUnit: existing.inputUnit,
        jurisdictionCountry: existing.jurisdictionCountry,
        jurisdictionRegion: existing.jurisdictionRegion,
        factorYear: existing.factorYear,
        status: { in: ['OFFICIAL', 'VERIFIED'] },
      },
    });

    if (!replacement && ['OFFICIAL', 'VERIFIED'].includes(existing.status)) {
      throw new BadRequestException(
        'Cannot archive the latest active factor version unless another active version replaces it.',
      );
    }

    const updated = await this.prisma.factorVersion.update({
      where: { id },
      data: { status: 'ARCHIVED' },
      include: { factor: true, source: true },
    });

    await this.logFactorVersionChange({
      factorId: existing.factorId,
      factorVersionId: id,
      action: 'VERSION_ARCHIVED',
      oldFactorVersionId: existing.id,
      newFactorVersionId: updated.id,
      oldValue: existing,
      newValue: updated,
      reason,
      changedBy,
    });

    return updated;
  }

  async isProductionReady(id: string) {
    const version = await this.findGovernedFactorVersion(id);
    return this.isProductionReadyVersion(version);
  }

  isOfficialSource(sourceAuthority?: string | null) {
    return isOfficialSourceAuthority(sourceAuthority);
  }

  async getFactorVersions(factorId: string, includeArchived = true) {
    await this.ensureFactorExists(factorId);

    const versions = await this.prisma.factorVersion.findMany({
      where: {
        factorId,
        ...(includeArchived ? {} : { status: { not: 'ARCHIVED' } }),
      },
      include: { factor: true, source: true },
      orderBy: [{ factorYear: 'desc' }, { createdAt: 'desc' }],
    });

    return {
      items: versions.map((version) => this.toFactorVersionDto(version)),
      total: versions.length,
      currentActiveVersion: this.toFactorVersionDto(
        versions.find((version) => ['VERIFIED', 'OFFICIAL'].includes(version.status)) ??
          versions.find((version) => version.status === 'DRAFT') ??
          versions[0],
      ),
    };
  }

  async getFactorVersion(id: string) {
    const version = await this.findGovernedFactorVersion(id);
    return this.toFactorVersionDto(version);
  }

  async getFactorVersionUsage(id: string) {
    await this.findGovernedFactorVersion(id);

    const metricResults = await this.prisma.metricResult.findMany({
      where: { factorVersionId: id },
      select: {
        id: true,
        organizationId: true,
        activityDataId: true,
        metricType: true,
        calculationDate: true,
      },
      orderBy: { calculationDate: 'desc' },
    });

    const activityRecordIds = new Set(
      metricResults.map((item) => item.activityDataId).filter(Boolean),
    );
    const organizationIds = new Set(metricResults.map((item) => item.organizationId));

    return {
      reportsUsingThisFactor: 0,
      activityRecordsUsingThisFactor: activityRecordIds.size,
      calculations: metricResults.length,
      organizations: organizationIds.size,
      recentCalculations: metricResults.slice(0, 10),
    };
  }

  async getFactorHistory(factorId: string) {
    await this.ensureFactorExists(factorId);

    const logs = await this.prisma.factorChangeLog.findMany({
      where: { factorId },
      include: {
        factorVersion: true,
        oldFactorVersion: true,
        newFactorVersion: true,
        changedByUser: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return { items: logs, total: logs.length };
  }

  async createNewFactorVersion(
    factorId: string,
    data: CreateFactorVersionDto,
    reason?: string,
    changedBy?: string,
  ) {
    const factor = await this.ensureFactorExists(factorId);
    const previous = await this.prisma.factorVersion.findFirst({
      where: { factorId },
      include: { factor: true, source: true },
      orderBy: [{ factorYear: 'desc' }, { createdAt: 'desc' }],
    });

    if (!previous && (!data.factorValue || !data.inputUnit || !data.resultUnit || !data.sourceId)) {
      throw new BadRequestException(
        'factorValue, inputUnit, resultUnit, and sourceId are required for the first factor version.',
      );
    }

    const sourceId = data.sourceId ?? previous?.sourceId;
    if (!sourceId) {
      throw new BadRequestException('Source is required for a factor version.');
    }
    await this.ensureSourceExists(sourceId);

    const factorYear = data.factorYear ?? previous?.factorYear ?? null;
    const nextVersion = data.version ?? (await this.nextVersionLabel(factorId, factorYear));

    const created = await this.prisma.factorVersion.create({
      data: {
        factorId,
        version: nextVersion,
        factorValue: new Prisma.Decimal(data.factorValue ?? Number(previous?.factorValue)),
        inputUnit: data.inputUnit ?? previous?.inputUnit ?? '',
        resultUnit: data.resultUnit ?? previous?.resultUnit ?? '',
        jurisdictionCountry: data.jurisdictionCountry ?? previous?.jurisdictionCountry ?? null,
        jurisdictionRegion: data.jurisdictionRegion ?? previous?.jurisdictionRegion ?? null,
        factorYear,
        effectiveFrom: parseOptionalDate(data.effectiveFrom) ?? previous?.effectiveFrom ?? null,
        effectiveTo: parseOptionalDate(data.effectiveTo) ?? previous?.effectiveTo ?? null,
        status: 'DRAFT',
        confidenceLevel: data.confidenceLevel ?? previous?.confidenceLevel ?? 'DEMO',
        methodology: data.methodology ?? previous?.methodology ?? null,
        verificationStatus: data.verificationStatus ?? previous?.verificationStatus ?? null,
        verified: false,
        sourceId,
        sourcePage: data.sourcePage ?? previous?.sourcePage ?? null,
        sourceTable: data.sourceTable ?? previous?.sourceTable ?? null,
        sourceSection: data.sourceSection ?? previous?.sourceSection ?? null,
        sourceRow: data.sourceRow ?? previous?.sourceRow ?? null,
        sourceColumn: data.sourceColumn ?? previous?.sourceColumn ?? null,
        citationText: data.citationText ?? previous?.citationText ?? null,
        notes: data.notes ?? previous?.notes ?? null,
      },
      include: { factor: true, source: true },
    });

    await this.logFactorVersionChange({
      factorId,
      factorVersionId: created.id,
      oldFactorVersionId: previous?.id,
      newFactorVersionId: created.id,
      action: inferVersionCreateAction(previous, created),
      oldValue: previous,
      newValue: created,
      reason,
      changedBy,
    });

    return this.toFactorVersionDto(created, factor.displayName);
  }

  async updateDraftFactorVersion(
    id: string,
    dto: UpdateFactorVersionDraftDto,
    reason?: string,
    changedBy?: string,
  ) {
    const existing = await this.findGovernedFactorVersion(id);
    this.ensureDraftEditable(existing);

    if (dto.sourceId !== undefined) {
      await this.ensureSourceExists(dto.sourceId);
    }

    const updated = await this.prisma.factorVersion.update({
      where: { id },
      data: {
        ...(dto.version !== undefined ? { version: dto.version } : {}),
        ...(dto.factorValue !== undefined ? { factorValue: new Prisma.Decimal(dto.factorValue) } : {}),
        ...(dto.inputUnit !== undefined ? { inputUnit: dto.inputUnit } : {}),
        ...(dto.resultUnit !== undefined ? { resultUnit: dto.resultUnit } : {}),
        ...(dto.jurisdictionCountry !== undefined ? { jurisdictionCountry: dto.jurisdictionCountry || null } : {}),
        ...(dto.jurisdictionRegion !== undefined ? { jurisdictionRegion: dto.jurisdictionRegion || null } : {}),
        ...(dto.factorYear !== undefined ? { factorYear: dto.factorYear ?? null } : {}),
        ...(dto.effectiveFrom !== undefined ? { effectiveFrom: parseOptionalDate(dto.effectiveFrom) } : {}),
        ...(dto.effectiveTo !== undefined ? { effectiveTo: parseOptionalDate(dto.effectiveTo) } : {}),
        ...(dto.confidenceLevel !== undefined ? { confidenceLevel: dto.confidenceLevel } : {}),
        ...(dto.methodology !== undefined ? { methodology: dto.methodology || null } : {}),
        ...(dto.verificationStatus !== undefined ? { verificationStatus: dto.verificationStatus || null } : {}),
        ...(dto.sourceId !== undefined ? { sourceId: dto.sourceId } : {}),
        ...(dto.sourcePage !== undefined ? { sourcePage: dto.sourcePage || null } : {}),
        ...(dto.sourceTable !== undefined ? { sourceTable: dto.sourceTable || null } : {}),
        ...(dto.sourceSection !== undefined ? { sourceSection: dto.sourceSection || null } : {}),
        ...(dto.sourceRow !== undefined ? { sourceRow: dto.sourceRow || null } : {}),
        ...(dto.sourceColumn !== undefined ? { sourceColumn: dto.sourceColumn || null } : {}),
        ...(dto.citationText !== undefined ? { citationText: dto.citationText || null } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
      },
      include: { factor: true, source: true },
    });

    await this.logFactorVersionChange({
      factorId: existing.factorId,
      factorVersionId: id,
      oldFactorVersionId: existing.id,
      newFactorVersionId: updated.id,
      action: inferDraftUpdateAction(existing, updated),
      oldValue: existing,
      newValue: updated,
      reason,
      changedBy,
    });

    return this.toFactorVersionDto(updated);
  }

  async getApplicableFactor(input: ApplicableFactorInput): Promise<ApplicableFactor> {
    const activityType = input.activityType as ActivityType;
    const normalizedInputUnit = normalizeUnit(input.inputUnit || input.unit || '');
    const recordYear = input.recordYear ?? input.factorYear ?? inferYear(input.recordDate);
    const country = normalizeJurisdictionCountry(input.jurisdictionCountry) ?? 'Canada';
    const region = normalizeJurisdictionRegion(input.jurisdictionRegion);
    const allowPlaceholderFactors = Boolean(input.allowPlaceholderFactors ?? input.allowDemoFactors);
    const allowSystemFactors = input.allowSystemFactors !== false;

    if (!normalizedInputUnit || isNumericUnit(normalizedInputUnit)) {
      return noApplicableFactor({
        status: 'INVALID_UNIT',
        matchedBy: 'INVALID_UNIT',
        message: `Unit '${input.inputUnit || input.unit || ''}' could not be matched to a supported unit for ${formatActivityType(String(activityType))}.`,
      });
    }

    if (isTrackedOnlyActivity(String(activityType))) {
      return noApplicableFactor({
        status: 'TRACKED_ONLY',
        matchedBy: 'TRACKED_ONLY',
        message:
          'Water usage is tracked for operational insight. Emissions are optional and require a reviewed water emissions factor.',
      });
    }

    if (activityType === 'ELECTRICITY' && !region) {
      return noApplicableFactor({
        status: 'MISSING_JURISDICTION',
        matchedBy: 'NO_MATCH',
        message:
          'Electricity factors are province-specific. Please provide a province or facility location.',
      });
    }

    const legacyFactors = await this.prisma.conversionFactor.findMany({
      where: {
        type: 'EMISSION',
        activityType,
        OR: [{ organizationId: input.organizationId }, { isSystemDefault: true }],
      },
      orderBy: [
        { isSystemDefault: 'asc' },
        { verified: 'desc' },
        { isDefault: 'desc' },
        { updatedAt: 'desc' },
      ],
    });

    const legacyMatches = legacyFactors.filter(
      (factor) => normalizeUnit(factor.unit) === normalizedInputUnit,
    );
    const organizationCustom = legacyMatches.find(
      (factor) =>
        factor.organizationId === input.organizationId &&
        factor.verified &&
        factorYearMatches(factor.sourceYear, recordYear) &&
        countryMatches(factor.country, country) &&
        regionCompatibleForActivity(String(activityType), factor.region || factor.jurisdiction, region),
    );

    if (organizationCustom) {
      return matchedApplicableFactor({
        factorValue: Number(organizationCustom.factorValue),
        inputUnit: organizationCustom.unit,
        resultUnit: organizationCustom.resultUnit,
        factorId: organizationCustom.id,
        displayName: organizationCustom.name,
        sourceAuthority: organizationCustom.sourceAuthority ?? organizationCustom.sourceName,
        sourceDocument: organizationCustom.sourceDocument ?? organizationCustom.sourceReference,
        sourceYear: organizationCustom.sourceYear,
        sourceUrl: organizationCustom.sourceUrl,
        status: organizationCustom.verified ? 'VERIFIED' : 'DRAFT',
        confidenceLevel: organizationCustom.confidenceLevel ?? 'CUSTOM',
        factorType: 'ORGANIZATION_CUSTOM',
        jurisdictionCountry: normalizeJurisdictionCountry(organizationCustom.country) ?? country,
        jurisdictionRegion: normalizeJurisdictionRegion(organizationCustom.region || organizationCustom.jurisdiction),
        factorYear: organizationCustom.sourceYear,
      }, {
        status: 'MATCHED',
        matchedBy: 'ORGANIZATION_CUSTOM_EXACT',
        message: `Matched organization custom verified factor for ${formatActivityType(String(activityType))} / ${normalizedInputUnit}.`,
      });
    }

    const governedVersions = await this.prisma.factorVersion.findMany({
      where: {
        factor: {
          activityType,
          isActive: true,
        },
        status: {
          notIn: ['DEPRECATED', 'ARCHIVED'] as FactorStatus[],
        },
      },
      include: {
        factor: true,
        source: true,
      },
      orderBy: [
        { status: 'desc' },
        { factorYear: 'desc' },
        { updatedAt: 'desc' },
      ],
    });

    const governedCandidates = governedVersions
      .filter((version) => !['DEPRECATED', 'ARCHIVED'].includes(version.status))
      .filter((version) => version.source?.isActive !== false)
      .filter((version) =>
        ['VERIFIED', 'OFFICIAL'].includes(version.status) ||
        (allowPlaceholderFactors && version.confidenceLevel === 'DEMO'),
      )
      .filter((version) => normalizeUnit(version.inputUnit) === normalizedInputUnit)
      .filter((version) => countryMatches(version.jurisdictionCountry, country));

    const exactRegionYear = governedCandidates
      .filter((version) => version.factorYear === recordYear)
      .filter((version) => regionMatchesExactly(version.jurisdictionRegion, region))
      .sort(compareFactorVersions(recordYear))[0];
    if (exactRegionYear) {
      return matchedGovernedVersion(exactRegionYear, {
        status: exactRegionYear.factor.isSystem ? 'MATCHED_SYSTEM_DEFAULT' : 'MATCHED',
        matchedBy: exactRegionYear.factor.isSystem ? 'SYSTEM_EXACT_REGION_YEAR' : 'OFFICIAL_EXACT_REGION_YEAR',
        message:
          activityType === 'ELECTRICITY'
            ? `Matched ${region} electricity factor for ${recordYear}.`
            : `Matched ${region} ${recordYear} factor for ${formatActivityType(String(activityType))}.`,
      });
    }

    const countryYear = governedCandidates
      .filter((version) => version.factorYear === recordYear)
      .filter((version) => isCountryLevel(version.jurisdictionRegion, version.jurisdictionCountry))
      .sort(compareFactorVersions(recordYear))[0];
    if (countryYear && allowsCountryLevelFallback(String(activityType))) {
      return matchedGovernedVersion(countryYear, {
        status: countryYear.factor.isSystem ? 'MATCHED_SYSTEM_DEFAULT' : 'MATCHED_COUNTRY_LEVEL',
        matchedBy: countryYear.factor.isSystem ? 'SYSTEM_COUNTRY_YEAR' : 'OFFICIAL_COUNTRY_YEAR',
        message: `Matched Canada-level factor for ${formatActivityType(String(activityType))} because no province-specific factor was required or available.`,
      });
    }

    const priorYear = governedCandidates
      .filter((version) => typeof version.factorYear === 'number' && Number(version.factorYear) < Number(recordYear))
      .filter((version) =>
        regionMatchesExactly(version.jurisdictionRegion, region) ||
        (allowsCountryLevelFallback(String(activityType)) &&
          isCountryLevel(version.jurisdictionRegion, version.jurisdictionCountry)),
      )
      .sort((a, b) => Number(b.factorYear ?? 0) - Number(a.factorYear ?? 0) || compareFactorVersions(recordYear)(a, b))[0];
    if (priorYear) {
      return matchedGovernedVersion(priorYear, {
        status: 'MATCHED_PRIOR_YEAR',
        matchedBy: 'PRIOR_YEAR',
        message: `Using nearest prior-year factor because no factor was found for the ${recordYear} record year.`,
        warnings: ['Using nearest prior-year factor because no factor was found for the record year.'],
      });
    }

    const legacySystemDefault = allowSystemFactors
      ? legacyMatches.find((factor) => {
          if (!factor.isSystemDefault) return false;
          if (factor.sourceYear && recordYear && factor.sourceYear !== recordYear) return false;
          if (activityType === 'ELECTRICITY') {
            return regionMatchesExactly(factor.region || factor.jurisdiction, region);
          }

          return allowsCountryLevelFallback(String(activityType));
        })
      : null;
    if (legacySystemDefault) {
      const factorRegion = normalizeJurisdictionRegion(
        legacySystemDefault.region || legacySystemDefault.jurisdiction,
      );
      const isCountryFallback = !factorRegion || factorRegion === 'Canada';

      return matchedApplicableFactor({
        factorValue: Number(legacySystemDefault.factorValue),
        inputUnit: legacySystemDefault.unit,
        resultUnit: legacySystemDefault.resultUnit,
        factorId: legacySystemDefault.id,
        displayName: legacySystemDefault.name,
        sourceAuthority: legacySystemDefault.sourceAuthority ?? legacySystemDefault.sourceName,
        sourceDocument: legacySystemDefault.sourceDocument ?? legacySystemDefault.sourceReference,
        sourceYear: legacySystemDefault.sourceYear,
        sourceUrl: legacySystemDefault.sourceUrl,
        status: legacySystemDefault.verified ? 'VERIFIED' : 'DRAFT',
        confidenceLevel: legacySystemDefault.confidenceLevel ?? 'DEMO',
        factorType: 'LEGACY_SYSTEM_DEFAULT',
        jurisdictionCountry: normalizeJurisdictionCountry(legacySystemDefault.country) ?? country,
        jurisdictionRegion: factorRegion,
        factorYear: legacySystemDefault.sourceYear,
      }, {
        status: isCountryFallback ? 'MATCHED_SYSTEM_DEFAULT' : 'MATCHED_SYSTEM_DEFAULT',
        matchedBy: isCountryFallback ? 'SYSTEM_COUNTRY_YEAR' : 'SYSTEM_EXACT_REGION_YEAR',
        message:
          activityType === 'ELECTRICITY'
            ? `Matched ${region} electricity system factor.`
            : `Matched Canada-level factor for ${formatActivityType(String(activityType))} because no province-specific factor was required or available.`,
      });
    }

    if (activityType === 'ELECTRICITY') {
      return noApplicableFactor({
        status: 'NO_MATCH',
        matchedBy: 'NO_MATCH',
        message: `No electricity factor found for ${region}. Electricity factors should not fall back across provinces.`,
      });
    }

    return noApplicableFactor({
      status: 'NO_MATCH',
      matchedBy: 'NO_MATCH',
      message: `No conversion factor found for ${formatActivityType(String(activityType))} / ${normalizedInputUnit}.`,
    });
  }

  async create(organizationId: string, dto: CreateConversionFactorDto, userId?: string) {
    this.validateDateRange(dto.effectiveFrom, dto.effectiveTo);

    const created = await this.prisma.conversionFactor.create({
      data: {
        organizationId,
        isSystemDefault: false,
        name: dto.name,
        type: dto.type as FactorType,
        activityType: dto.activityType
          ? (dto.activityType as ActivityType)
          : null,
        jurisdiction: dto.jurisdiction ?? null,
        region: dto.region ?? null,
        country: dto.country ?? null,
        unit: dto.unit,
        factorValue: new Prisma.Decimal(dto.factorValue),
        resultUnit: dto.resultUnit,
        sourceName: dto.sourceName ?? null,
        sourceReference: dto.sourceReference ?? null,
        sourceAuthority: dto.sourceAuthority ?? null,
        sourceDocument: dto.sourceDocument ?? null,
        sourceYear: dto.sourceYear ?? null,
        sourceUrl: dto.sourceUrl ?? null,
        methodology: dto.methodology ?? null,
        confidenceLevel: dto.confidenceLevel ?? null,
        verificationStatus: dto.verificationStatus ?? null,
        verified: dto.verified ?? false,
        notes: dto.notes ?? null,
        effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : null,
        effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
        isDefault: dto.isDefault ?? false,
      },
    });

    await this.auditLog.log({
      organizationId,
      userId,
      action: 'CREATE_CONVERSION_FACTOR',
      entityType: 'ConversionFactor',
      entityId: created.id,
      description: `Created conversion factor ${created.name}`,
      newValue: created,
    });

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'CONVERSION_FACTOR_CREATED',
      entityType: 'ConversionFactor',
      entityId: created.id,
      metadata: {
        activityType: created.activityType,
        inputUnit: created.unit,
        type: created.type,
      },
    });

    return created;
  }

  async findAll(organizationId: string, query: ConversionFactorQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.ConversionFactorWhereInput = {
      OR: [
        { isSystemDefault: true },
        { organizationId },
      ],
      ...(query.type ? { type: query.type as FactorType } : {}),
      ...(query.activityType
        ? { activityType: query.activityType as ActivityType }
        : {}),
      ...(query.jurisdiction
        ? {
            jurisdiction: {
              contains: query.jurisdiction,
              mode: 'insensitive',
            },
          }
        : {}),
      ...(query.sourceYear ? { sourceYear: query.sourceYear } : {}),
      ...(query.search
        ? {
            AND: [
              {
                OR: [
                  { name: { contains: query.search, mode: 'insensitive' } },
                  { unit: { contains: query.search, mode: 'insensitive' } },
                  { resultUnit: { contains: query.search, mode: 'insensitive' } },
                  {
                    sourceName: {
                      contains: query.search,
                      mode: 'insensitive',
                    },
                  },
                  {
                    sourceReference: {
                      contains: query.search,
                      mode: 'insensitive',
                    },
                  },
                  {
                    jurisdiction: {
                      contains: query.search,
                      mode: 'insensitive',
                    },
                  },
                  { region: { contains: query.search, mode: 'insensitive' } },
                  { country: { contains: query.search, mode: 'insensitive' } },
                ],
              },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.conversionFactor.findMany({
        where,
        orderBy: [
          { isSystemDefault: 'asc' },
          { isDefault: 'desc' },
          { createdAt: 'desc' },
        ],
        skip,
        take: pageSize,
      }),
      this.prisma.conversionFactor.count({ where }),
    ]);

    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async findOne(organizationId: string, id: string) {
    const factor = await this.prisma.conversionFactor.findFirst({
      where: {
        id,
        OR: [
          { isSystemDefault: true },
          { organizationId },
        ],
      },
    });

    if (!factor) {
      throw new NotFoundException(`ConversionFactor ${id} not found.`);
    }

    return factor;
  }

  async update(organizationId: string, id: string, dto: UpdateConversionFactorDto, userId?: string) {
    const existing = await this.ensureEditable(organizationId, id);
    this.validateDateRange(dto.effectiveFrom, dto.effectiveTo);

    const updated = await this.prisma.conversionFactor.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.type !== undefined ? { type: dto.type as FactorType } : {}),
        ...(dto.activityType !== undefined
          ? {
              activityType: dto.activityType
                ? (dto.activityType as ActivityType)
                : null,
            }
          : {}),
        ...(dto.jurisdiction !== undefined
          ? { jurisdiction: dto.jurisdiction || null }
          : {}),
        ...(dto.region !== undefined ? { region: dto.region || null } : {}),
        ...(dto.country !== undefined ? { country: dto.country || null } : {}),
        ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
        ...(dto.factorValue !== undefined
          ? { factorValue: new Prisma.Decimal(dto.factorValue) }
          : {}),
        ...(dto.resultUnit !== undefined ? { resultUnit: dto.resultUnit } : {}),
        ...(dto.sourceName !== undefined
          ? { sourceName: dto.sourceName || null }
          : {}),
        ...(dto.sourceReference !== undefined
          ? { sourceReference: dto.sourceReference || null }
          : {}),
        ...(dto.sourceAuthority !== undefined
          ? { sourceAuthority: dto.sourceAuthority || null }
          : {}),
        ...(dto.sourceDocument !== undefined
          ? { sourceDocument: dto.sourceDocument || null }
          : {}),
        ...(dto.sourceYear !== undefined
          ? { sourceYear: dto.sourceYear ?? null }
          : {}),
        ...(dto.sourceUrl !== undefined
          ? { sourceUrl: dto.sourceUrl || null }
          : {}),
        ...(dto.methodology !== undefined
          ? { methodology: dto.methodology || null }
          : {}),
        ...(dto.confidenceLevel !== undefined
          ? { confidenceLevel: dto.confidenceLevel || null }
          : {}),
        ...(dto.verificationStatus !== undefined
          ? { verificationStatus: dto.verificationStatus || null }
          : {}),
        ...(dto.verified !== undefined ? { verified: dto.verified } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
        ...(dto.effectiveFrom !== undefined
          ? {
              effectiveFrom: dto.effectiveFrom
                ? new Date(dto.effectiveFrom)
                : null,
            }
          : {}),
        ...(dto.effectiveTo !== undefined
          ? {
              effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
            }
          : {}),
        ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
        isSystemDefault: false,
      },
    });

    await this.auditLog.log({
      organizationId,
      userId,
      action: 'UPDATE_CONVERSION_FACTOR',
      entityType: 'ConversionFactor',
      entityId: id,
      description: `Updated conversion factor ${updated.name}`,
      oldValue: existing,
      newValue: updated,
    });

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'CONVERSION_FACTOR_UPDATED',
      entityType: 'ConversionFactor',
      entityId: id,
      metadata: {
        changedFields: Object.keys(dto),
        activityType: updated.activityType,
        inputUnit: updated.unit,
      },
    });

    return updated;
  }

  async remove(organizationId: string, id: string, userId?: string) {
    const existing = await this.ensureEditable(organizationId, id);

    await this.prisma.conversionFactor.delete({
      where: { id },
    });

    await this.auditLog.log({
      organizationId,
      userId,
      action: 'DELETE_CONVERSION_FACTOR',
      entityType: 'ConversionFactor',
      entityId: id,
      description: `Deleted conversion factor ${existing.name}`,
      oldValue: existing,
    });

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'CONVERSION_FACTOR_DELETED',
      entityType: 'ConversionFactor',
      entityId: id,
      metadata: {
        activityType: existing.activityType,
        inputUnit: existing.unit,
        type: existing.type,
      },
    });

    return {
      id,
      deleted: true,
    };
  }

  private async ensureEditable(organizationId: string, id: string) {
    const existing = await this.prisma.conversionFactor.findFirst({
      where: {
        id,
        OR: [{ isSystemDefault: true }, { organizationId }],
      },
    });

    if (!existing) {
      throw new NotFoundException(`ConversionFactor ${id} not found.`);
    }

    if (existing.isSystemDefault) {
      throw new ForbiddenException('System default factors cannot be modified.');
    }

    if (existing.organizationId !== organizationId) {
      throw new NotFoundException(`ConversionFactor ${id} not found.`);
    }

    return existing;
  }

  async findGovernedFactorVersion(id: string) {
    const version = await this.prisma.factorVersion.findUnique({
      where: { id },
      include: { factor: true, source: true },
    });

    if (!version) {
      throw new NotFoundException(`FactorVersion ${id} not found.`);
    }

    return version;
  }

  private async ensureFactorExists(factorId: string) {
    const factor = await this.prisma.factor.findUnique({ where: { id: factorId } });
    if (!factor) {
      throw new NotFoundException(`Factor ${factorId} not found.`);
    }
    return factor;
  }

  private async ensureSourceExists(sourceId: string) {
    const source = await this.prisma.factorSource.findUnique({ where: { id: sourceId } });
    if (!source) {
      throw new NotFoundException(`FactorSource ${sourceId} not found.`);
    }
    return source;
  }

  private ensureDraftEditable(version: NonNullable<FactorVersionWithGovernance>) {
    if (version.status !== 'DRAFT') {
      throw new BadRequestException(
        'Verified or official factor versions are immutable. Create a new factor version instead.',
      );
    }
  }

  private async nextVersionLabel(factorId: string, factorYear?: number | null) {
    const year = factorYear ?? new Date().getFullYear();
    const prefix = `v${year}.`;
    const existing = await this.prisma.factorVersion.findMany({
      where: { factorId, version: { startsWith: prefix } },
      select: { version: true },
    });
    const suffixes = existing
      .map((item) => Number(item.version.replace(prefix, '')))
      .filter((value) => Number.isFinite(value));
    const next = suffixes.length ? Math.max(...suffixes) + 1 : 1;
    return `${prefix}${next}`;
  }

  private toFactorVersionDto(
    version?: (NonNullable<FactorVersionWithGovernance> & { factor?: { displayName?: string; isSystem?: boolean } }) | null,
    fallbackName?: string,
  ) {
    if (!version) return null;
    return {
      id: version.id,
      factorId: version.factorId,
      displayName: version.factor?.displayName ?? fallbackName,
      isSystem: version.factor?.isSystem ?? null,
      version: version.version,
      factorValue: Number(version.factorValue),
      inputUnit: version.inputUnit,
      resultUnit: version.resultUnit,
      jurisdictionCountry: version.jurisdictionCountry,
      jurisdictionRegion: version.jurisdictionRegion,
      factorYear: version.factorYear,
      effectiveFrom: version.effectiveFrom,
      effectiveTo: version.effectiveTo,
      status: version.status,
      confidenceLevel: version.confidenceLevel,
      methodology: version.methodology,
      verificationStatus: version.verificationStatus,
      verified: version.verified,
      reviewedBy: version.reviewedBy,
      reviewedAt: version.reviewedAt,
      reviewNotes: version.reviewNotes,
      approvalSource: version.approvalSource,
      sourceId: version.sourceId,
      sourcePage: version.sourcePage,
      sourceSection: version.sourceSection,
      sourceTable: version.sourceTable,
      sourceRow: version.sourceRow,
      sourceColumn: version.sourceColumn,
      citationText: version.citationText,
      source: version.source
        ? {
            id: version.source.id,
            sourceAuthority: version.source.sourceAuthority,
            sourceShortName: version.source.sourceShortName,
            sourceDocument: version.source.sourceDocument,
            sourceYear: version.source.sourceYear,
            sourceUrl: version.source.sourceUrl,
            sourceVersion: version.source.sourceVersion,
            publishedDate: version.source.publishedDate,
            page: version.source.page,
            tableReference: version.source.tableReference,
            isOfficial: version.source.isOfficial,
            isActive: version.source.isActive,
            publisherType: version.source.publisherType,
          }
        : null,
      notes: version.notes,
      createdAt: version.createdAt,
      updatedAt: version.updatedAt,
    };
  }

  private validateProductionReadiness(
    version: NonNullable<FactorVersionWithGovernance>,
    input: FactorReviewInput & { reviewedAt: Date; status: FactorStatus },
  ) {
    if (input.status !== 'VERIFIED') return;

    if (!input.reviewedBy?.trim()) {
      throw new BadRequestException('Reviewed by is required before verifying a factor version.');
    }

    if (!input.reviewedAt || Number.isNaN(input.reviewedAt.getTime())) {
      throw new BadRequestException('Reviewed at is required before verifying a factor version.');
    }

    if (!version.source) {
      throw new BadRequestException('A source is required before verifying a factor version.');
    }

    if (version.factorValue === null || version.factorValue === undefined) {
      throw new BadRequestException('Factor value is required before verifying a factor version.');
    }

    if (!version.jurisdictionCountry && !version.jurisdictionRegion) {
      throw new BadRequestException('Jurisdiction is required before verifying a factor version.');
    }

    if (!version.factorYear) {
      throw new BadRequestException('Factor year is required before verifying a factor version.');
    }

    if (['VERIFIED', 'OFFICIAL'].includes(input.status)) {
      this.validateActiveOfficialSource(version.source);
    }

    if (version.confidenceLevel === 'OFFICIAL_GOVERNMENT') {
      this.validateActiveOfficialSource(version.source);

      if (version.source.publisherType !== 'GOVERNMENT') {
        throw new BadRequestException(
          'Official government confidence requires a government source.',
        );
      }

      if (!this.isOfficialSource(version.source.sourceAuthority)) {
        throw new BadRequestException(
          'Official government confidence requires an official source authority.',
        );
      }
    }
  }

  private isProductionReadyVersion(version: NonNullable<FactorVersionWithGovernance>) {
    return Boolean(
      version.status === 'VERIFIED' &&
        version.verified &&
        version.reviewedBy?.trim() &&
        version.reviewedAt &&
        version.source &&
        version.source.isActive &&
        version.source.isOfficial &&
        version.factorValue !== null &&
        version.factorValue !== undefined &&
        (version.jurisdictionCountry || version.jurisdictionRegion) &&
        version.factorYear,
    );
  }

  private validateActiveOfficialSource(
    source?: { isActive?: boolean | null; isOfficial?: boolean | null } | null,
  ) {
    if (!source) {
      throw new BadRequestException('An active official source is required before marking a factor version production-ready.');
    }

    if (!source.isActive) {
      throw new BadRequestException('Archived sources cannot be used for new production-ready factor versions.');
    }

    if (!source.isOfficial) {
      throw new BadRequestException('A verified or official factor version must link to an official source.');
    }
  }

  private async deprecatePreviousProductionVersions(version: NonNullable<FactorVersionWithGovernance>) {
    const previousVersions = await this.prisma.factorVersion.findMany({
      where: {
        id: { not: version.id },
        factorId: version.factorId,
        inputUnit: version.inputUnit,
        jurisdictionCountry: version.jurisdictionCountry,
        jurisdictionRegion: version.jurisdictionRegion,
        factorYear: version.factorYear,
        status: { in: ['VERIFIED', 'OFFICIAL'] },
      },
      include: { factor: true, source: true },
    });

    for (const previous of previousVersions) {
      const deprecated = await this.prisma.factorVersion.update({
        where: { id: previous.id },
        data: { status: 'DEPRECATED' },
        include: { factor: true, source: true },
      });

      await this.logFactorVersionChange({
        factorId: previous.factorId,
        factorVersionId: previous.id,
        oldFactorVersionId: previous.id,
        newFactorVersionId: version.id,
        action: 'VERSION_DEPRECATED',
        oldValue: previous,
        newValue: deprecated,
        reason: `Replaced by factor version ${version.version}`,
        changedBy: version.reviewedBy ?? undefined,
      });
    }
  }

  private async logFactorVersionChange(input: {
    factorId: string;
    factorVersionId: string;
    oldFactorVersionId?: string | null;
    newFactorVersionId?: string | null;
    action: string;
    oldValue?: unknown;
    newValue?: unknown;
    reason?: string;
    changedBy?: string;
  }) {
    await this.prisma.factorChangeLog.create({
      data: {
        factorId: input.factorId,
        factorVersionId: input.factorVersionId,
        oldFactorVersionId: input.oldFactorVersionId ?? null,
        newFactorVersionId: input.newFactorVersionId ?? null,
        action: input.action,
        oldValue: input.oldValue
          ? (JSON.parse(JSON.stringify(input.oldValue)) as Prisma.InputJsonValue)
          : undefined,
        newValue: input.newValue
          ? (JSON.parse(JSON.stringify(input.newValue)) as Prisma.InputJsonValue)
          : undefined,
        reason: input.reason ?? null,
        changedBy: input.changedBy ?? null,
      },
    });
  }

  private validateDateRange(
    effectiveFrom?: string | null,
    effectiveTo?: string | null,
  ) {
    if (effectiveFrom && effectiveTo) {
      const from = new Date(effectiveFrom);
      const to = new Date(effectiveTo);

      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new BadRequestException('Invalid effective date range.');
      }

      if (from > to) {
        throw new BadRequestException(
          '`effectiveFrom` must be before or equal to `effectiveTo`.',
        );
      }
    }
  }
}


function parseOptionalDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException('Invalid factor version date.');
  }
  return date;
}

function inferVersionCreateAction(previous: unknown, created: { factorValue: Prisma.Decimal; sourceId: string }) {
  if (!previous) return 'VERSION_CREATED';
  const oldVersion = previous as { factorValue?: Prisma.Decimal; sourceId?: string };
  if (oldVersion.sourceId !== created.sourceId) return 'SOURCE_CHANGED';
  if (String(oldVersion.factorValue) !== String(created.factorValue)) return 'VALUE_CHANGED';
  return 'VERSION_CREATED';
}

function inferDraftUpdateAction(previous: { factorValue: Prisma.Decimal; sourceId: string }, updated: { factorValue: Prisma.Decimal; sourceId: string; status: string }) {
  if (previous.sourceId !== updated.sourceId) return 'SOURCE_CHANGED';
  if (String(previous.factorValue) !== String(updated.factorValue)) return 'VALUE_CHANGED';
  return 'STATUS_CHANGED';
}


const OFFICIAL_SOURCE_AUTHORITIES = [
  'environment and climate change canada',
  'eccc',
  'us epa',
  'epa',
  'defra',
  'ipcc',
  'ghg protocol',
  'greenhouse gas protocol',
];

function isOfficialSourceAuthority(sourceAuthority?: string | null) {
  const source = normalizeText(sourceAuthority);
  if (!source) return false;
  return OFFICIAL_SOURCE_AUTHORITIES.some(
    (authority) => source === authority || source.includes(authority),
  );
}

function normalizeText(value?: string | null) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function inferYear(value?: Date | string | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getUTCFullYear();
}

function isNumericUnit(unit?: string | null) {
  const normalized = String(unit ?? '').trim();
  return normalized !== '' && Number.isFinite(Number(normalized));
}

function isTrackedOnlyActivity(activityType?: string | null) {
  return ['WATER', 'WASTE', 'WASTE_VOLUME'].includes(String(activityType ?? '').toUpperCase());
}

function allowsCountryLevelFallback(activityType?: string | null) {
  return ['DIESEL', 'GASOLINE', 'NATURAL_GAS', 'HOTEL', 'PROPANE'].includes(
    String(activityType ?? '').toUpperCase(),
  );
}

function factorYearMatches(factorYear?: number | null, recordYear?: number | null) {
  return !factorYear || !recordYear || factorYear === recordYear;
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

function matchedApplicableFactor(
  factor: FactorMatchResult,
  explanation: Pick<ApplicableFactor, 'status' | 'matchedBy' | 'message'> & {
    warnings?: string[];
  },
): ApplicableFactor {
  return {
    matched: true,
    factor,
    ...factor,
    status: explanation.status,
    matchedBy: explanation.matchedBy,
    message: explanation.message,
    warnings: explanation.warnings ?? [],
  };
}

function matchedGovernedVersion(
  version: Prisma.FactorVersionGetPayload<{ include: { factor: true; source: true } }>,
  explanation: Pick<ApplicableFactor, 'status' | 'matchedBy' | 'message'> & {
    warnings?: string[];
  },
): ApplicableFactor {
  return matchedApplicableFactor(
    {
      factorValue: Number(version.factorValue),
      inputUnit: version.inputUnit,
      resultUnit: version.resultUnit,
      factorId: version.factorId,
      factorVersionId: version.id,
      displayName: version.factor.displayName,
      sourceAuthority: version.source?.sourceAuthority ?? null,
      sourceDocument: version.source?.sourceDocument ?? null,
      sourceYear: version.source?.sourceYear ?? version.factorYear,
      sourceUrl: version.source?.sourceUrl ?? null,
      status: version.status,
      confidenceLevel: version.confidenceLevel,
      factorType: 'GOVERNED_LIBRARY',
      jurisdictionCountry: normalizeJurisdictionCountry(version.jurisdictionCountry),
      jurisdictionRegion: normalizeJurisdictionRegion(version.jurisdictionRegion),
      factorYear: version.factorYear,
    },
    explanation,
  );
}

function noApplicableFactor(input: {
  status: ApplicableFactor['status'];
  matchedBy: ApplicableFactor['matchedBy'];
  message: string;
  warnings?: string[];
}): ApplicableFactor {
  return {
    matched: false,
    factor: null,
    status: input.status,
    matchedBy: input.matchedBy,
    message: input.message,
    warnings: input.warnings ?? [],
  };
}

function formatActivityType(activityType?: string | null) {
  return String(activityType ?? 'activity')
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function compareFactorVersions(requestedYear?: number | null) {
  const statusRank: Record<string, number> = {
    VERIFIED: 5,
    OFFICIAL: 4,
    DRAFT: 3,
    DEPRECATED: 1,
    ARCHIVED: 0,
  };

  return (a: { status: string; factorYear: number | null; updatedAt: Date }, b: { status: string; factorYear: number | null; updatedAt: Date }) => {
    const aExactYear = requestedYear && a.factorYear === requestedYear ? 1 : 0;
    const bExactYear = requestedYear && b.factorYear === requestedYear ? 1 : 0;
    if (aExactYear !== bExactYear) return bExactYear - aExactYear;

    const statusDiff = (statusRank[b.status] ?? 0) - (statusRank[a.status] ?? 0);
    if (statusDiff !== 0) return statusDiff;

    return b.updatedAt.getTime() - a.updatedAt.getTime();
  };
}

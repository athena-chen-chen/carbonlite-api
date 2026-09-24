import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Prisma, RecordSourceType, ActivityType, ReportStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateActivityDataDto } from './dto/create-activity-data.dto';
import { UpdateActivityDataDto } from './dto/update-activity-data.dto';
import { ActivityDataQueryDto } from './dto/activity-data-query.dto';
import { BulkImportActivityDataDto } from './dto/bulk-import-activity-data.dto';
import { JsonActivityDataPreviewDto } from './dto/json-activity-data-preview.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ActivityTrackingService } from '../activity-tracking/activity-tracking.service';
import {
  buildJsonActivityPreview,
  parseJsonActivityPayload,
  toJsonPreviewFactorCandidates,
} from './json-activity-records';
import {
  PerfTimer,
  SLOW_REQUEST_THRESHOLD_MS,
  timeAsync,
  timeSync,
} from '../common/monitoring/performance-logging';
import {
  getDateOnlyYear,
  parseDateOnlyRangeEndUtc,
  parseDateOnlyUtc,
} from '../common/date-only';
import { CLEAR_ACTIVITY_RECORDS_CONFIRMATION } from './dto/clear-activity-records.dto';
import { RESET_DEMO_DATA_CONFIRMATION } from './dto/reset-demo-data.dto';

@Injectable()
export class ActivityDataService {
  private readonly logger = new Logger(ActivityDataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly activityTracking: ActivityTrackingService,
  ) {}

  async create(organizationId: string, dto: CreateActivityDataDto, userId?: string) {
    await this.validateRelations(organizationId, dto);

    const data = {
      organizationId,
      facilityId: dto.facilityId ?? null,
      facilityName: resolveFacilityName(dto),
      assetId: dto.assetId ?? null,
      documentId: dto.documentId ?? null,
      activityType: dto.activityType,
      customTypeLabel: dto.customTypeLabel ?? null,
      recordDate: parseDateOnlyUtc(dto.recordDate),
      dateEstimated: dto.dateEstimated ?? false,
      jurisdictionCountry: dto.jurisdictionCountry ?? null,
      jurisdictionRegion: dto.jurisdictionRegion ?? null,
      recordYear: dto.recordYear ?? getDateOnlyYear(dto.recordDate),
      periodStart: dto.periodStart ? new Date(dto.periodStart) : null,
      periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : null,
      quantity: new Prisma.Decimal(dto.quantity),
      unit: dto.unit,
      sourceType: dto.sourceType,
      sourceReference: dto.sourceReference ?? null,
      sourceFileName: dto.sourceFileName ?? null,
      sourceDocumentId: dto.sourceDocumentId ?? null,
      sourcePage: normalizeOptionalText(dto.sourcePage),
      sourceRow: normalizeOptionalText(dto.sourceRow),
      sourceTextSnippet: dto.sourceTextSnippet ?? null,
      importBatchId: dto.importBatchId ?? null,
      notes: dto.notes ?? null,
      ...buildCalculationFieldCreateData(dto),
    };

    let created;
    try {
      created = await this.prisma.activityData.create({ data });
    } catch (error) {
      this.logger.error(
        [
          'ActivityData create failed.',
          `dto=${JSON.stringify(sanitizeActivityDataCreateDto(dto))}`,
          `prismaData=${JSON.stringify(sanitizePrismaDataForLog(data))}`,
          getErrorMessage(error),
        ].join(' '),
        getErrorStack(error),
      );
      throw error;
    }

    await this.auditLog.log({
      organizationId,
      userId,
      action: 'CREATE_ACTIVITY_RECORD',
      entityType: 'ActivityData',
      entityId: created.id,
      description: 'Created activity record',
      newValue: created,
    });

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'ACTIVITY_RECORD_CREATED',
      entityType: 'ActivityData',
      entityId: created.id,
      metadata: {
        activityType: created.activityType,
        unit: created.unit,
        sourceType: created.sourceType,
      },
    });

    return created;
  }

  async bulkImport(organizationId: string, dto: BulkImportActivityDataDto, userId?: string) {
    const totalTimer = new PerfTimer();

    if (!dto.items?.length) {
      throw new BadRequestException('No activity data items provided.');
    }

    const validationTimer = new PerfTimer();
    for (const item of dto.items) {
      await this.validateRelations(organizationId, item);
    }
    const validationDurationMs = validationTimer.elapsedMs();

    const parseTimer = new PerfTimer();
    const rows = dto.items.map((item) => ({
      organizationId,
      facilityId: item.facilityId ?? null,
      facilityName: resolveFacilityName(item),
      assetId: item.assetId ?? null,
      documentId: item.documentId ?? null,
      activityType: item.activityType as ActivityType,
      customTypeLabel: item.customTypeLabel ?? null,
      recordDate: parseDateOnlyUtc(item.recordDate),
      dateEstimated: item.dateEstimated ?? false,
      jurisdictionCountry: item.jurisdictionCountry ?? null,
      jurisdictionRegion: item.jurisdictionRegion ?? null,
      recordYear: item.recordYear ?? getDateOnlyYear(item.recordDate),
      periodStart: item.periodStart ? new Date(item.periodStart) : null,
      periodEnd: item.periodEnd ? new Date(item.periodEnd) : null,
      quantity: new Prisma.Decimal(item.quantity),
      unit: item.unit,
      sourceType: item.sourceType as RecordSourceType,
      sourceReference: item.sourceReference ?? null,
      sourceFileName: item.sourceFileName ?? null,
      sourceDocumentId: item.sourceDocumentId ?? null,
      sourcePage: normalizeOptionalText(item.sourcePage),
      sourceRow: normalizeOptionalText(item.sourceRow),
      sourceTextSnippet: item.sourceTextSnippet ?? null,
      importBatchId: item.importBatchId ?? null,
      notes: item.notes ?? null,
      ...buildCalculationFieldCreateData(item),
    }));
    const parseDurationMs = parseTimer.elapsedMs();

    const { result, durationMs: databaseInsertUpdateDurationMs } =
      await timeAsync(() =>
        this.prisma.activityData.createMany({
          data: rows,
        }),
      );

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'ACTIVITY_RECORD_IMPORTED',
      entityType: 'ActivityData',
      metadata: {
        count: result.count,
        sourceType: rows[0]?.sourceType ?? null,
      },
    });

    this.logImportPerformance('activityDataBulkImport', {
      totalDurationMs: totalTimer.elapsedMs(),
      parseDurationMs,
      validationDurationMs,
      databaseInsertUpdateDurationMs,
      count: result.count,
    });

    return {
      count: result.count,
      message: `Imported ${result.count} activity data records.`,
    };
  }

  async previewJsonImport(organizationId: string, dto: JsonActivityDataPreviewDto) {
    const totalTimer = new PerfTimer();
    const { result: records, durationMs: parseDurationMs } = timeSync(() =>
      parseJsonActivityPayload({
        jsonContent: dto.jsonContent,
        data: dto.data,
      }),
    );
    const activityTypes = [
      ActivityType.ELECTRICITY,
      ActivityType.NATURAL_GAS,
      ActivityType.GASOLINE,
      ActivityType.DIESEL,
      ActivityType.AIR_TRAVEL,
      ActivityType.HOTEL,
      ActivityType.CUSTOM,
    ];
    const { result: factorResults, durationMs: databaseReadDurationMs } =
      await timeAsync(() =>
        this.prisma.$transaction([
          this.prisma.conversionFactor.findMany({
            where: {
              type: 'EMISSION',
              activityType: { in: activityTypes },
              OR: [{ organizationId }, { isSystemDefault: true }],
            },
            select: {
              id: true,
              name: true,
              activityType: true,
              unit: true,
              factorValue: true,
              resultUnit: true,
              jurisdiction: true,
              region: true,
              country: true,
              sourceYear: true,
            },
          }),
          this.prisma.factorVersion.findMany({
            where: {
              factor: {
                activityType: { in: activityTypes },
                isActive: true,
              },
              status: { notIn: ['DEPRECATED', 'ARCHIVED'] },
            },
            select: {
              id: true,
              inputUnit: true,
              factorValue: true,
              resultUnit: true,
              jurisdictionRegion: true,
              jurisdictionCountry: true,
              factorYear: true,
              factor: {
                select: {
                  activityType: true,
                },
              },
            },
          }),
        ]),
      );
    const [legacyFactors, governedFactors] = factorResults;

    const { result: preview, durationMs: validationDurationMs } = timeSync(() =>
      buildJsonActivityPreview({
        records,
        sourceFileName: dto.sourceFileName,
        factors: toJsonPreviewFactorCandidates({ legacyFactors, governedFactors }),
      }),
    );

    this.logImportPerformance('activityDataJsonPreview', {
      totalDurationMs: totalTimer.elapsedMs(),
      parseDurationMs,
      validationDurationMs,
      databaseInsertUpdateDurationMs: 0,
      databaseReadDurationMs,
      count: records.length,
    });

    return preview;
  }

  async findAll(organizationId: string, query: ActivityDataQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.ActivityDataWhereInput = {
      organizationId,
      ...(query.facilityId ? { facilityId: query.facilityId } : {}),
      ...(query.activityType ? { activityType: query.activityType as ActivityType } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            recordDate: {
              ...(query.dateFrom ? { gte: parseDateOnlyUtc(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: parseDateOnlyRangeEndUtc(query.dateTo) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { unit: { contains: query.search, mode: 'insensitive' } },
              { sourceReference: { contains: query.search, mode: 'insensitive' } },
              { notes: { contains: query.search, mode: 'insensitive' } },
              { customTypeLabel: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    let items;
    let total;

    try {
      [items, total] = await this.prisma.$transaction([
        this.prisma.activityData.findMany({
          where,
          include: {
            facility: true,
            asset: true,
            document: true,
          },
          orderBy: {
            recordDate: 'desc',
          },
          skip,
          take: pageSize,
        }),
        this.prisma.activityData.count({ where }),
      ]);
    } catch (error) {
      this.logger.error(
        [
          'ActivityData findAll failed.',
          `query=${JSON.stringify(query)}`,
          `where=${JSON.stringify(sanitizePrismaDataForLog(where))}`,
          getErrorMessage(error),
        ].join(' '),
        getErrorStack(error),
      );
      throw error;
    }

    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async findOne(organizationId: string, id: string) {
    const item = await this.prisma.activityData.findFirst({
      where: {
        id,
        organizationId,
      },
      include: {
        facility: true,
        asset: true,
        document: true,
        metricResults: true,
      },
    });

    if (!item) {
      throw new NotFoundException(`ActivityData ${id} not found.`);
    }

    return item;
  }

  async update(organizationId: string, id: string, dto: UpdateActivityDataDto, userId?: string) {
    const existing = await this.ensureExists(organizationId, id);
    await this.validateRelations(organizationId, dto);

    const updated = await this.prisma.activityData.update({
      where: { id },
      data: {
        ...(dto.facilityId !== undefined ? { facilityId: dto.facilityId || null } : {}),
        ...(dto.facility !== undefined || dto.facilityName !== undefined
          ? { facilityName: resolveFacilityName(dto) }
          : {}),
        ...(dto.assetId !== undefined ? { assetId: dto.assetId || null } : {}),
        ...(dto.documentId !== undefined ? { documentId: dto.documentId || null } : {}),
        ...(dto.activityType !== undefined
          ? { activityType: dto.activityType as ActivityType }
          : {}),
        ...(dto.customTypeLabel !== undefined
          ? { customTypeLabel: dto.customTypeLabel || null }
          : {}),
        ...(dto.recordDate !== undefined ? { recordDate: parseDateOnlyUtc(dto.recordDate) } : {}),
        ...(dto.dateEstimated !== undefined
          ? { dateEstimated: dto.dateEstimated }
          : {}),
        ...(dto.jurisdictionCountry !== undefined
          ? { jurisdictionCountry: dto.jurisdictionCountry || null }
          : {}),
        ...(dto.jurisdictionRegion !== undefined
          ? { jurisdictionRegion: dto.jurisdictionRegion || null }
          : {}),
        ...(dto.recordYear !== undefined
          ? { recordYear: dto.recordYear || null }
          : dto.recordDate !== undefined
            ? { recordYear: getDateOnlyYear(dto.recordDate) }
            : {}),
        ...(dto.periodStart !== undefined
          ? { periodStart: dto.periodStart ? new Date(dto.periodStart) : null }
          : {}),
        ...(dto.periodEnd !== undefined
          ? { periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : null }
          : {}),
        ...(dto.quantity !== undefined ? { quantity: new Prisma.Decimal(dto.quantity) } : {}),
        ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
        ...(dto.sourceType !== undefined
          ? { sourceType: dto.sourceType as RecordSourceType }
          : {}),
        ...(dto.sourceReference !== undefined
          ? { sourceReference: dto.sourceReference || null }
          : {}),
        ...(dto.sourceFileName !== undefined
          ? { sourceFileName: dto.sourceFileName || null }
          : {}),
        ...(dto.sourceDocumentId !== undefined
          ? { sourceDocumentId: dto.sourceDocumentId || null }
          : {}),
        ...(dto.sourcePage !== undefined
          ? { sourcePage: normalizeOptionalText(dto.sourcePage) }
          : {}),
        ...(dto.sourceRow !== undefined
          ? { sourceRow: normalizeOptionalText(dto.sourceRow) }
          : {}),
        ...(dto.sourceTextSnippet !== undefined
          ? { sourceTextSnippet: dto.sourceTextSnippet || null }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
        ...buildCalculationFieldUpdateData(dto),
      },
    });

    await this.auditLog.log({
      organizationId,
      userId,
      action: 'UPDATE_ACTIVITY_RECORD',
      entityType: 'ActivityData',
      entityId: id,
      description: 'Updated activity record',
      oldValue: existing,
      newValue: updated,
    });

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'ACTIVITY_RECORD_UPDATED',
      entityType: 'ActivityData',
      entityId: id,
      metadata: {
        changedFields: Object.keys(dto),
      },
    });

    return updated;
  }

  async remove(organizationId: string, id: string, userId?: string) {
    const existing = await this.ensureExists(organizationId, id);
    const result = await this.prisma.activityData.deleteMany({
      where: {
        id,
        organizationId,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException(`ActivityData ${id} not found.`);
    }

    await this.auditLog.log({
      organizationId,
      userId,
      action: 'DELETE_ACTIVITY_RECORD',
      entityType: 'ActivityData',
      entityId: id,
      description: 'Deleted activity record',
      oldValue: existing,
    });

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'ACTIVITY_RECORD_DELETED',
      entityType: 'ActivityData',
      entityId: id,
      metadata: {
        activityType: existing.activityType,
        unit: existing.unit,
      },
    });

    return {
      id,
      deleted: true,
      deletedCount: result.count,
    };
  }

  async bulkDelete(organizationId: string, ids: string[], userId?: string) {
    const uniqueIds = Array.from(new Set(ids));
    const existing = await this.prisma.activityData.findMany({
      where: {
        id: { in: uniqueIds },
        organizationId,
      },
    });

    const result = await this.prisma.activityData.deleteMany({
      where: {
        id: { in: uniqueIds },
        organizationId,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('No activity data records were deleted.');
    }

    await this.auditLog.log({
      organizationId,
      userId,
      action: 'BULK_DELETE_ACTIVITY_RECORDS',
      entityType: 'ActivityData',
      description: `Bulk deleted ${result.count} activity records`,
      oldValue: existing,
      newValue: { ids: uniqueIds, deletedCount: result.count },
    });

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'ACTIVITY_RECORD_BULK_DELETED',
      entityType: 'ActivityData',
      metadata: {
        requestedCount: uniqueIds.length,
        deletedCount: result.count,
      },
    });

    return {
      ids: uniqueIds,
      deleted: true,
      deletedCount: result.count,
    };
  }

  async bulkUpdateProvince(
    organizationId: string,
    ids: string[],
    province: string,
    userId?: string,
  ) {
    const uniqueIds = Array.from(
      new Set(ids.map((id) => String(id).trim()).filter(Boolean)),
    );
    const normalizedProvince = normalizeProvinceInput(province);

    if (!uniqueIds.length) {
      throw new BadRequestException('No eligible activity records selected.');
    }

    if (!normalizedProvince) {
      throw new BadRequestException('Select a province before applying.');
    }

    const eligibleRecords = await this.prisma.activityData.findMany({
      where: {
        id: { in: uniqueIds },
        organizationId,
        activityType: ActivityType.ELECTRICITY,
      },
    });

    if (!eligibleRecords.length) {
      throw new BadRequestException('No selected electricity records.');
    }

    const eligibleIds = eligibleRecords.map((record) => record.id);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.activityData.updateMany({
        where: {
          id: { in: eligibleIds },
          organizationId,
        },
        data: {
          jurisdictionRegion: normalizedProvince,
        },
      });

      return tx.activityData.findMany({
        where: {
          id: { in: eligibleIds },
          organizationId,
        },
      });
    });

    await this.auditLog.log({
      organizationId,
      userId,
      action: 'BULK_UPDATE_ACTIVITY_RECORD_PROVINCE',
      entityType: 'ActivityData',
      description: `Set province on ${updated.length} electricity activity records`,
      oldValue: eligibleRecords,
      newValue: {
        ids: eligibleIds,
        province: normalizedProvince,
        updatedCount: updated.length,
      },
    });

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'ACTIVITY_RECORDS_PROVINCE_UPDATED',
      entityType: 'ActivityData',
      metadata: {
        requestedCount: uniqueIds.length,
        updatedCount: updated.length,
        province: normalizedProvince,
      },
    });

    return {
      ids: eligibleIds,
      province: normalizedProvince,
      updatedCount: updated.length,
      updatedRecords: updated,
    };
  }

  async clearForOrganization(
    organizationId: string,
    userId: string | undefined,
    confirmation: string,
  ) {
    if (confirmation !== CLEAR_ACTIVITY_RECORDS_CONFIRMATION) {
      throw new BadRequestException('Confirmation text is invalid.');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const activityRecords = await tx.activityData.findMany({
        where: { organizationId },
        select: { id: true },
      });
      const activityRecordIds = activityRecords.map((record) => record.id);

      const deletedCalculationResults = activityRecordIds.length
        ? await tx.metricResult.deleteMany({
            where: {
              organizationId,
              activityDataId: { in: activityRecordIds },
            },
          })
        : { count: 0 };

      const deletedActivityRecords = await tx.activityData.deleteMany({
        where: { organizationId },
      });

      return {
        deletedActivityRecords: deletedActivityRecords.count,
        deletedCalculationResults: deletedCalculationResults.count,
      };
    });

    await this.auditLog.log({
      organizationId,
      userId,
      action: 'CLEAR_ACTIVITY_RECORDS',
      entityType: 'ActivityData',
      description: 'Cleared activity records for organization',
      newValue: result,
    });

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'ACTIVITY_RECORDS_CLEARED',
      entityType: 'ActivityData',
      metadata: result,
    });

    return {
      deletedActivityRecords: result.deletedActivityRecords,
      deletedCalculationResults: result.deletedCalculationResults,
      deletedCalculationDetails: result.deletedCalculationResults,
      clearedMetricsCache: 0,
      deletedImportBatches: 0,
      resetReports: 0,
      message: 'Activity records cleared successfully.',
    };
  }

  async resetDemoDataForOrganization(
    organizationId: string,
    userId: string | undefined,
    confirmation: string,
  ) {
    if (confirmation !== RESET_DEMO_DATA_CONFIRMATION) {
      throw new BadRequestException('Confirmation text is invalid.');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const [activityRecords, documents, extractions] = await Promise.all([
        tx.activityData.findMany({
          where: { organizationId },
          select: { id: true, importBatchId: true },
        }),
        tx.document.findMany({
          where: { organizationId },
          select: { id: true, importBatchId: true },
        }),
        tx.documentExtraction.findMany({
          where: { organizationId },
          select: { extractedRowCount: true, sourceRowCount: true },
        }),
      ]);

      const activityRecordIds = activityRecords.map((record) => record.id);
      const documentIds = documents.map((document) => document.id);
      const importBatchIds = new Set(
        [...activityRecords, ...documents]
          .map((item) => item.importBatchId?.trim())
          .filter((id): id is string => Boolean(id)),
      );
      const stagedRowsDeleted = extractions.reduce(
        (total, extraction) =>
          total +
          (extraction.extractedRowCount || extraction.sourceRowCount || 0),
        0,
      );

      const metricsCacheCleared = activityRecordIds.length
        ? await tx.metricResult.deleteMany({
            where: {
              organizationId,
              activityDataId: { in: activityRecordIds },
            },
          })
        : { count: 0 };

      const activityRecordsDeleted = await tx.activityData.deleteMany({
        where: { organizationId },
      });

      const stagedRowsCleared = documentIds.length
        ? await tx.documentExtraction.deleteMany({
            where: {
              organizationId,
              documentId: { in: documentIds },
            },
          })
        : { count: 0 };

      const uploadedDocumentsDeleted = await tx.document.deleteMany({
        where: { organizationId },
      });

      const resetReports = await tx.report.updateMany({
        where: {
          organizationId,
          status: ReportStatus.DRAFT,
        },
        data: {
          summary: null,
          contentMarkdown: null,
          generatedPdfUrl: null,
        },
      });

      return {
        activityRecordsDeleted: activityRecordsDeleted.count,
        importBatchesDeleted: importBatchIds.size,
        uploadedDocumentsDeleted: uploadedDocumentsDeleted.count,
        stagedRowsDeleted,
        stagedExtractionRecordsDeleted: stagedRowsCleared.count,
        metricsCacheCleared: metricsCacheCleared.count,
        resetReports: resetReports.count,
      };
    });

    await this.auditLog.log({
      organizationId,
      userId,
      action: 'RESET_DEMO_DATA',
      entityType: 'Organization',
      description: 'Reset demo data for organization',
      newValue: result,
    });

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'DEMO_DATA_RESET',
      entityType: 'Organization',
      metadata: result,
    });

    return {
      ...result,
      message: 'Demo data reset successfully.',
    };
  }

  private async ensureExists(organizationId: string, id: string) {
    const existing = await this.prisma.activityData.findFirst({
      where: {
        id,
        organizationId,
      },
    });

    if (!existing) {
      throw new NotFoundException(`ActivityData ${id} not found.`);
    }

    return existing;
  }

  private async validateRelations(
    organizationId: string,
    dto: Partial<{
      facilityId?: string;
      assetId?: string;
      documentId?: string;
    }>,
  ) {
    if (dto.facilityId) {
      const facility = await this.prisma.facility.findFirst({
        where: {
          id: dto.facilityId,
          organizationId,
        },
        select: { id: true },
      });

      if (!facility) {
        throw new BadRequestException(`Facility ${dto.facilityId} not found.`);
      }
    }

    if (dto.assetId) {
      const asset = await this.prisma.asset.findFirst({
        where: {
          id: dto.assetId,
          facility: {
            organizationId,
          },
        },
        select: { id: true },
      });

      if (!asset) {
        throw new BadRequestException(`Asset ${dto.assetId} not found.`);
      }
    }

    if (dto.documentId) {
      const document = await this.prisma.document.findFirst({
        where: {
          id: dto.documentId,
          organizationId,
        },
        select: { id: true },
      });

      if (!document) {
        throw new BadRequestException(`Document ${dto.documentId} not found.`);
      }
    }
  }

  private logImportPerformance(
    operation: string,
    timings: {
      totalDurationMs: number;
      parseDurationMs: number;
      validationDurationMs: number;
      databaseInsertUpdateDurationMs: number;
      databaseReadDurationMs?: number;
      count: number;
    },
  ) {
    const message = [
      `${operation} total=${timings.totalDurationMs}ms`,
      `parse=${timings.parseDurationMs}ms`,
      `validation=${timings.validationDurationMs}ms`,
      `databaseInsertUpdate=${timings.databaseInsertUpdateDurationMs}ms`,
      timings.databaseReadDurationMs !== undefined
        ? `databaseRead=${timings.databaseReadDurationMs}ms`
        : null,
      `records=${timings.count}`,
    ]
      .filter(Boolean)
      .join(' ');

    if (timings.totalDurationMs > SLOW_REQUEST_THRESHOLD_MS) {
      this.logger.warn(`SLOW ${message}`);
      return;
    }

    this.logger.log(message);
  }
}

function normalizeOptionalText(value?: string | number | null) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function buildCalculationFieldCreateData(dto: CreateActivityDataDto) {
  return {
    matchingStatus: dto.matchingStatus ?? null,
    reportTreatment: dto.reportTreatment ?? null,
    scope: dto.scope ?? null,
    matchedFactorId: dto.matchedFactorId ?? null,
    matchedFactorName: dto.matchedFactorName ?? null,
    matchedFactorSourceYear: dto.matchedFactorSourceYear ?? null,
    matchedFactorValue: dto.matchedFactorValue ?? null,
    matchedFactorUnit: dto.matchedFactorUnit ?? null,
    matchedFactorVersion: dto.matchedFactorVersion ?? null,
    matchedFactorSourceAuthority: dto.matchedFactorSourceAuthority ?? null,
    matchedFactorSourceDocument: dto.matchedFactorSourceDocument ?? null,
    matchedFactorVerificationStatus: dto.matchedFactorVerificationStatus ?? null,
    matchedFactorConfidenceLevel: dto.matchedFactorConfidenceLevel ?? null,
    matchedFactorAssumptions: dto.matchedFactorAssumptions ?? null,
    calculatedEmissionsKgCO2e: dto.calculatedEmissionsKgCO2e ?? null,
    calculationStatus: dto.calculationStatus ?? null,
    calculationMessage: dto.calculationMessage ?? null,
  };
}

function buildCalculationFieldUpdateData(dto: UpdateActivityDataDto) {
  return {
    ...(dto.matchingStatus !== undefined ? { matchingStatus: dto.matchingStatus || null } : {}),
    ...(dto.reportTreatment !== undefined ? { reportTreatment: dto.reportTreatment || null } : {}),
    ...(dto.scope !== undefined ? { scope: dto.scope || null } : {}),
    ...(dto.matchedFactorId !== undefined ? { matchedFactorId: dto.matchedFactorId || null } : {}),
    ...(dto.matchedFactorName !== undefined ? { matchedFactorName: dto.matchedFactorName || null } : {}),
    ...(dto.matchedFactorSourceYear !== undefined
      ? { matchedFactorSourceYear: dto.matchedFactorSourceYear ?? null }
      : {}),
    ...(dto.matchedFactorValue !== undefined
      ? { matchedFactorValue: dto.matchedFactorValue ?? null }
      : {}),
    ...(dto.matchedFactorUnit !== undefined
      ? { matchedFactorUnit: dto.matchedFactorUnit || null }
      : {}),
    ...(dto.matchedFactorVersion !== undefined
      ? { matchedFactorVersion: dto.matchedFactorVersion || null }
      : {}),
    ...(dto.matchedFactorSourceAuthority !== undefined
      ? { matchedFactorSourceAuthority: dto.matchedFactorSourceAuthority || null }
      : {}),
    ...(dto.matchedFactorSourceDocument !== undefined
      ? { matchedFactorSourceDocument: dto.matchedFactorSourceDocument || null }
      : {}),
    ...(dto.matchedFactorVerificationStatus !== undefined
      ? { matchedFactorVerificationStatus: dto.matchedFactorVerificationStatus || null }
      : {}),
    ...(dto.matchedFactorConfidenceLevel !== undefined
      ? { matchedFactorConfidenceLevel: dto.matchedFactorConfidenceLevel || null }
      : {}),
    ...(dto.matchedFactorAssumptions !== undefined
      ? { matchedFactorAssumptions: dto.matchedFactorAssumptions || null }
      : {}),
    ...(dto.calculatedEmissionsKgCO2e !== undefined
      ? { calculatedEmissionsKgCO2e: dto.calculatedEmissionsKgCO2e ?? null }
      : {}),
    ...(dto.calculationStatus !== undefined
      ? { calculationStatus: dto.calculationStatus || null }
      : {}),
    ...(dto.calculationMessage !== undefined
      ? { calculationMessage: dto.calculationMessage || null }
      : {}),
  };
}

function resolveFacilityName(dto: Pick<CreateActivityDataDto, 'facility' | 'facilityName'>) {
  return normalizeOptionalText(dto.facilityName ?? dto.facility) ?? null;
}

function normalizeProvinceInput(value: string) {
  const normalized = String(value ?? '').trim().toLowerCase();
  const provinceMap: Record<string, string> = {
    alberta: 'AB',
    ab: 'AB',
    'british columbia': 'BC',
    bc: 'BC',
    ontario: 'ON',
    on: 'ON',
    saskatchewan: 'SK',
    sk: 'SK',
    manitoba: 'MB',
    mb: 'MB',
    quebec: 'QC',
    québec: 'QC',
    qc: 'QC',
    'nova scotia': 'NS',
    ns: 'NS',
    'new brunswick': 'NB',
    nb: 'NB',
    'newfoundland and labrador': 'NL',
    nl: 'NL',
    'prince edward island': 'PE',
    pei: 'PE',
    pe: 'PE',
    'northwest territories': 'NT',
    nt: 'NT',
    yukon: 'YT',
    yt: 'YT',
    nunavut: 'NU',
    nu: 'NU',
  };

  return provinceMap[normalized] ?? null;
}

function sanitizeActivityDataCreateDto(dto: CreateActivityDataDto) {
  return sanitizeForLog(dto);
}

function sanitizePrismaDataForLog(data: object) {
  return sanitizeForLog(data);
}

function sanitizeForLog(value: object) {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, fieldValue]) => [
      key,
      fieldValue instanceof Prisma.Decimal ? fieldValue.toString() : fieldValue,
    ]),
  );
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getErrorStack(error: unknown) {
  return error instanceof Error ? error.stack : undefined;
}

import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, RecordSourceType, ActivityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateActivityDataDto } from './dto/create-activity-data.dto';
import { UpdateActivityDataDto } from './dto/update-activity-data.dto';
import { ActivityDataQueryDto } from './dto/activity-data-query.dto';
import { BulkImportActivityDataDto } from './dto/bulk-import-activity-data.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ActivityTrackingService } from '../activity-tracking/activity-tracking.service';

@Injectable()
export class ActivityDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly activityTracking: ActivityTrackingService,
  ) {}

  async create(organizationId: string, dto: CreateActivityDataDto, userId?: string) {
    await this.validateRelations(organizationId, dto);

    const created = await this.prisma.activityData.create({
      data: {
        organizationId,
        facilityId: dto.facilityId ?? null,
        assetId: dto.assetId ?? null,
        documentId: dto.documentId ?? null,
        activityType: dto.activityType,
        customTypeLabel: dto.customTypeLabel ?? null,
        recordDate: new Date(dto.recordDate),
        dateEstimated: dto.dateEstimated ?? false,
        periodStart: dto.periodStart ? new Date(dto.periodStart) : null,
        periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : null,
        quantity: new Prisma.Decimal(dto.quantity),
        unit: dto.unit,
        sourceType: dto.sourceType,
        sourceReference: dto.sourceReference ?? null,
        sourceFileName: dto.sourceFileName ?? null,
        sourceDocumentId: dto.sourceDocumentId ?? null,
        importBatchId: dto.importBatchId ?? null,
        notes: dto.notes ?? null,
      },
    });

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
    if (!dto.items?.length) {
      throw new BadRequestException('No activity data items provided.');
    }

    for (const item of dto.items) {
      await this.validateRelations(organizationId, item);
    }

    const rows = dto.items.map((item) => ({
      organizationId,
      facilityId: item.facilityId ?? null,
      assetId: item.assetId ?? null,
      documentId: item.documentId ?? null,
      activityType: item.activityType as ActivityType,
      customTypeLabel: item.customTypeLabel ?? null,
      recordDate: new Date(item.recordDate),
      dateEstimated: item.dateEstimated ?? false,
      periodStart: item.periodStart ? new Date(item.periodStart) : null,
      periodEnd: item.periodEnd ? new Date(item.periodEnd) : null,
      quantity: new Prisma.Decimal(item.quantity),
      unit: item.unit,
      sourceType: item.sourceType as RecordSourceType,
      sourceReference: item.sourceReference ?? null,
      sourceFileName: item.sourceFileName ?? null,
      sourceDocumentId: item.sourceDocumentId ?? null,
      importBatchId: item.importBatchId ?? null,
      notes: item.notes ?? null,
    }));

    const result = await this.prisma.activityData.createMany({
      data: rows,
    });

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

    return {
      count: result.count,
      message: `Imported ${result.count} activity data records.`,
    };
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
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
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

    const [items, total] = await this.prisma.$transaction([
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
        ...(dto.assetId !== undefined ? { assetId: dto.assetId || null } : {}),
        ...(dto.documentId !== undefined ? { documentId: dto.documentId || null } : {}),
        ...(dto.activityType !== undefined
          ? { activityType: dto.activityType as ActivityType }
          : {}),
        ...(dto.customTypeLabel !== undefined
          ? { customTypeLabel: dto.customTypeLabel || null }
          : {}),
        ...(dto.recordDate !== undefined ? { recordDate: new Date(dto.recordDate) } : {}),
        ...(dto.dateEstimated !== undefined
          ? { dateEstimated: dto.dateEstimated }
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
        ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
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
}

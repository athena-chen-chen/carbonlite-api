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

@Injectable()
export class ActivityDataService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, dto: CreateActivityDataDto) {
    await this.validateRelations(organizationId, dto);

    return this.prisma.activityData.create({
      data: {
        organizationId,
        facilityId: dto.facilityId ?? null,
        assetId: dto.assetId ?? null,
        documentId: dto.documentId ?? null,
        activityType: dto.activityType,
        customTypeLabel: dto.customTypeLabel ?? null,
        recordDate: new Date(dto.recordDate),
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
  }

  async bulkImport(organizationId: string, dto: BulkImportActivityDataDto) {
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

  async update(organizationId: string, id: string, dto: UpdateActivityDataDto) {
    await this.ensureExists(organizationId, id);
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

    return updated;
  }

  async remove(organizationId: string, id: string) {
    const result = await this.prisma.activityData.deleteMany({
      where: {
        id,
        organizationId,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException(`ActivityData ${id} not found.`);
    }

    return {
      id,
      deleted: true,
      deletedCount: result.count,
    };
  }

  async bulkDelete(organizationId: string, ids: string[]) {
    const uniqueIds = Array.from(new Set(ids));

    const result = await this.prisma.activityData.deleteMany({
      where: {
        id: { in: uniqueIds },
        organizationId,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('No activity data records were deleted.');
    }

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
      select: { id: true },
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

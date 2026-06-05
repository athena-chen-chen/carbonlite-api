import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReportStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReportDto } from './dto/create-report.dto';
import { ReportQueryDto } from './dto/report-query.dto';
import { UpdateReportDto } from './dto/update-report.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ActivityTrackingService } from '../activity-tracking/activity-tracking.service';

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly activityTracking: ActivityTrackingService,
  ) {}

  async create(organizationId: string, userId: string, dto: CreateReportDto) {
    await this.validateFacility(organizationId, dto.facilityId);

    const created = await this.prisma.report.create({
      data: {
        organizationId,
        createdById: userId,
        title: dto.title,
        facilityId: dto.facilityId ?? null,
        reportingYear: dto.reportingYear ?? null,
        periodStart: dto.periodStart ? new Date(dto.periodStart) : null,
        periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : null,
      },
    });

    await this.auditLog.log({
      organizationId,
      userId,
      action: 'GENERATE_REPORT',
      entityType: 'Report',
      entityId: created.id,
      description: `Generated report ${created.title}`,
      newValue: created,
    });

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'REPORT_GENERATED',
      entityType: 'Report',
      entityId: created.id,
      metadata: {
        reportingYear: created.reportingYear,
        periodStart: created.periodStart,
        periodEnd: created.periodEnd,
      },
    });

    return created;
  }

  async findAll(organizationId: string, query: ReportQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.ReportWhereInput = {
      organizationId,
      ...(query.facilityId ? { facilityId: query.facilityId } : {}),
      ...(query.status ? { status: query.status as ReportStatus } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.report.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.report.count({ where }),
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
    const report = await this.prisma.report.findFirst({
      where: { id, organizationId },
      include: {
        facility: true,
        documents: true,
      },
    });

    if (!report) {
      throw new NotFoundException(`Report ${id} not found.`);
    }

    return report;
  }

  async update(organizationId: string, id: string, dto: UpdateReportDto) {
    await this.ensureExists(organizationId, id);
    await this.validateFacility(organizationId, dto.facilityId);

    return this.prisma.report.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.facilityId !== undefined
          ? { facilityId: dto.facilityId || null }
          : {}),
        ...(dto.reportingYear !== undefined
          ? { reportingYear: dto.reportingYear }
          : {}),
        ...(dto.periodStart !== undefined
          ? { periodStart: dto.periodStart ? new Date(dto.periodStart) : null }
          : {}),
        ...(dto.periodEnd !== undefined
          ? { periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : null }
          : {}),
      },
    });
  }

  async remove(organizationId: string, id: string) {
    await this.ensureExists(organizationId, id);
    await this.prisma.report.delete({ where: { id } });

    return { id, deleted: true };
  }

  private async ensureExists(organizationId: string, id: string) {
    const report = await this.prisma.report.findFirst({
      where: { id, organizationId },
      select: { id: true },
    });

    if (!report) {
      throw new NotFoundException(`Report ${id} not found.`);
    }

    return report;
  }

  private async validateFacility(
    organizationId: string,
    facilityId?: string | null,
  ) {
    if (!facilityId) return;

    const facility = await this.prisma.facility.findFirst({
      where: { id: facilityId, organizationId },
      select: { id: true },
    });

    if (!facility) {
      throw new BadRequestException(`Facility ${facilityId} not found.`);
    }
  }
}

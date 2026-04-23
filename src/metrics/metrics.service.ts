import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import {
  ActivityData,
  MetricType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CalculateMetricsDto } from './dto/calculate-metrics.dto';
import { MetricQueryDto } from './dto/metric-query.dto';
import { matchBestFactor } from './metrics.utils';

@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly defaultOrganizationId = 'demo-org-id';

  async calculate(dto: CalculateMetricsDto) {
    const activityRecords = await this.findTargetActivityRecords(dto);

    if (!activityRecords.length) {
      throw new BadRequestException('No activity data found for calculation.');
    }

    const requestedMetricTypes = dto.metricTypes as MetricType[];

    const factors = await this.prisma.conversionFactor.findMany({
      where: {
        OR: [
          { organizationId: this.defaultOrganizationId },
          { organizationId: null },
        ],
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });

    const createdResults: Array<{
      activityDataId: string;
      metricType: MetricType;
      metricResultId: string;
      factorId: string | null;
      value: string;
      unit: string;
    }> = [];

    for (const record of activityRecords) {
      for (const metricType of requestedMetricTypes) {
        if (metricType === 'ENERGY_INTENSITY') {
          continue;
        }

        const factor = matchBestFactor({
          activityType: record.activityType,
          unit: record.unit,
          factors,
          metricType,
        });

        if (!factor) {
          continue;
        }

        const value = this.calculateMetricValue(
          record.quantity,
          factor.factorValue,
        );

        // 关键：先删旧结果，避免重复计算后 summary 翻倍
        await this.prisma.metricResult.deleteMany({
          where: {
            organizationId: this.defaultOrganizationId,
            activityDataId: record.id,
            metricType,
          },
        });

        const result = await this.prisma.metricResult.create({
          data: {
            organizationId: this.defaultOrganizationId,
            facilityId: record.facilityId,
            activityDataId: record.id,
            factorId: factor.id,
            metricType,
            value,
            unit: factor.resultUnit,
            periodStart: record.periodStart,
            periodEnd: record.periodEnd,
            detailsJson: {
              activityType: record.activityType,
              sourceUnit: record.unit,
              factorType: factor.type,
              factorValue: factor.factorValue.toString(),
              factorUnit: factor.unit,
              resultUnit: factor.resultUnit,
            },
          },
        });

        createdResults.push({
          activityDataId: record.id,
          metricType,
          metricResultId: result.id,
          factorId: factor.id,
          value: result.value.toString(),
          unit: result.unit,
        });
      }
    }

    return {
      count: createdResults.length,
      items: createdResults,
    };
  }

  async findAll(query: MetricQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.MetricResultWhereInput = {
      organizationId: this.defaultOrganizationId,
      ...(query.facilityId ? { facilityId: query.facilityId } : {}),
      ...(query.metricType ? { metricType: query.metricType as MetricType } : {}),
      ...(query.periodStart || query.periodEnd
        ? {
            AND: [
              ...(query.periodStart
                ? [{ periodStart: { gte: new Date(query.periodStart) } }]
                : []),
              ...(query.periodEnd
                ? [{ periodEnd: { lte: new Date(query.periodEnd) } }]
                : []),
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.metricResult.findMany({
        where,
        include: {
          facility: true,
          activityData: true,
          factor: true,
        },
        orderBy: {
          calculationDate: 'desc',
        },
        skip,
        take: pageSize,
      }),
      this.prisma.metricResult.count({ where }),
    ]);

    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getSummary(query: MetricQueryDto) {
    const where: Prisma.MetricResultWhereInput = {
      organizationId: this.defaultOrganizationId,
      ...(query.facilityId ? { facilityId: query.facilityId } : {}),
      ...(query.metricType ? { metricType: query.metricType as MetricType } : {}),
      ...(query.periodStart || query.periodEnd
        ? {
            AND: [
              ...(query.periodStart
                ? [{ periodStart: { gte: new Date(query.periodStart) } }]
                : []),
              ...(query.periodEnd
                ? [{ periodEnd: { lte: new Date(query.periodEnd) } }]
                : []),
            ],
          }
        : {}),
    };

    const [groupedByMetric, groupedByFacility] = await Promise.all([
      this.prisma.metricResult.groupBy({
        by: ['metricType', 'unit'],
        where,
        _sum: {
          value: true,
        },
        _count: {
          _all: true,
        },
      }),
      this.prisma.metricResult.groupBy({
        by: ['facilityId', 'metricType', 'unit'],
        where,
        _sum: {
          value: true,
        },
      }),
    ]);

    return {
      totalsByMetric: groupedByMetric.map((row) => ({
        metricType: row.metricType,
        unit: row.unit,
        totalValue: row._sum.value?.toString() ?? '0',
        count: row._count._all,
      })),
      totalsByFacility: groupedByFacility.map((row) => ({
        facilityId: row.facilityId,
        metricType: row.metricType,
        unit: row.unit,
        totalValue: row._sum.value?.toString() ?? '0',
      })),
    };
  }

  private async findTargetActivityRecords(dto: CalculateMetricsDto): Promise<ActivityData[]> {
    if (dto.activityDataIds?.length) {
      return this.prisma.activityData.findMany({
        where: {
          id: { in: dto.activityDataIds },
          organizationId: this.defaultOrganizationId,
        },
      });
    }

    return this.prisma.activityData.findMany({
      where: {
        organizationId: this.defaultOrganizationId,
        ...(dto.facilityId ? { facilityId: dto.facilityId } : {}),
        ...(dto.periodStart || dto.periodEnd
          ? {
              recordDate: {
                ...(dto.periodStart ? { gte: new Date(dto.periodStart) } : {}),
                ...(dto.periodEnd ? { lte: new Date(dto.periodEnd) } : {}),
              },
            }
          : {}),
      },
    });
  }

  private calculateMetricValue(
    quantity: Prisma.Decimal,
    factorValue: Prisma.Decimal,
  ): Prisma.Decimal {
    return quantity.mul(factorValue);
  }
}
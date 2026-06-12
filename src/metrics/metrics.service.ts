import {
  BadRequestException,
  Injectable,
  Logger,
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
import { AuditLogService } from '../audit-log/audit-log.service';
import { addAppBreadcrumb } from '../common/monitoring/capture-app-error';
import { CalculationQualityService } from './calculation-quality.service';

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly calculationQuality: CalculationQualityService,
  ) {}

  async calculate(organizationId: string, dto: CalculateMetricsDto, userId?: string) {
    const activityRecords = await this.findTargetActivityRecords(organizationId, dto);

    if (!activityRecords.length) {
      throw new BadRequestException('No activity data found for calculation.');
    }

    const requestedMetricTypes = dto.metricTypes as MetricType[];
    const qualitySummary = requestedMetricTypes.includes('CARBON_EMISSION')
      ? await this.calculationQuality.buildSummary(organizationId, {
          selectedActivityRecordIds: activityRecords
            .map((record) => record.id)
            .join(','),
        })
      : null;
    const carbonDetailsByActivityId = new Map(
      (qualitySummary?.calculationDetails ?? []).map((detail) => [
        detail.activityDataId,
        detail,
      ]),
    );

    const factors = await this.prisma.conversionFactor.findMany({
      where: {
        OR: [{ isSystemDefault: true }, { organizationId }],
      },
      orderBy: [
        { isSystemDefault: 'asc' },
        { isDefault: 'desc' },
        { createdAt: 'desc' },
      ],
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

        const carbonDetail =
          metricType === 'CARBON_EMISSION'
            ? carbonDetailsByActivityId.get(record.id)
            : undefined;
        const factor =
          metricType === 'CARBON_EMISSION'
            ? factors.find((item) => item.id === carbonDetail?.factorId) ?? null
            : matchBestFactor({
                activityType: record.activityType,
                unit: record.unit,
                factors,
                metricType,
                organizationId,
              });

        if (!factor) {
          this.logger.warn(
            `No conversion factor match organizationId=${organizationId} activityDataId=${record.id} activityType=${record.activityType} unit=${record.unit} metricType=${metricType}`,
          );
          addAppBreadcrumb('No conversion factor match', {
            feature: 'metrics',
            operation: 'factor-match-missing',
            organizationId,
            entityType: 'ActivityData',
            entityId: record.id,
            metadata: {
              activityType: record.activityType,
              unit: record.unit,
              metricType,
            },
          });
          continue;
        }

        const value =
          metricType === 'CARBON_EMISSION' &&
          carbonDetail?.calculatedEmissionsKgCO2e !== null &&
          carbonDetail?.calculatedEmissionsKgCO2e !== undefined
            ? new Prisma.Decimal(carbonDetail.calculatedEmissionsKgCO2e)
            : this.calculateMetricValue(record.quantity, factor.factorValue);

        // 关键：先删旧结果，避免重复计算后 summary 翻倍
        await this.prisma.metricResult.deleteMany({
          where: {
            organizationId,
            activityDataId: record.id,
            metricType,
          },
        });

        const result = await this.prisma.metricResult.create({
          data: {
            organizationId,
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
              calculationStatus: carbonDetail?.status ?? 'CALCULATED',
              jurisdiction: carbonDetail?.jurisdiction ?? null,
              reportingYear: carbonDetail?.reportingYear ?? null,
              sourceAuthority: carbonDetail?.sourceAuthority ?? null,
              sourceDocument: carbonDetail?.sourceDocument ?? null,
              sourceUrl: carbonDetail?.sourceUrl ?? null,
              sourceYear: carbonDetail?.sourceYear ?? null,
              verified: carbonDetail?.factorVerified ?? factor.verified,
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

    const response = {
      count: createdResults.length,
      items: createdResults,
    };

    await this.auditLog.log({
      organizationId,
      userId,
      action: 'GENERATE_METRICS_SUMMARY',
      entityType: 'MetricResult',
      description: `Generated metrics summary with ${createdResults.length} metric results`,
      newValue: {
        request: dto,
        count: createdResults.length,
        activityRecordCount: activityRecords.length,
      },
    });

    return response;
  }

  async findAll(organizationId: string, query: MetricQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.MetricResultWhereInput = {
      organizationId,
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

  async getSummary(organizationId: string, query: MetricQueryDto) {
    return this.calculationQuality.buildSummary(organizationId, {
      periodStart: query.periodStart,
      periodEnd: query.periodEnd,
    });
  }

  private async findTargetActivityRecords(
    organizationId: string,
    dto: CalculateMetricsDto,
  ): Promise<ActivityData[]> {
    if (dto.activityDataIds?.length) {
      return this.prisma.activityData.findMany({
        where: {
          id: { in: dto.activityDataIds },
          organizationId,
        },
      });
    }

    return this.prisma.activityData.findMany({
      where: {
        organizationId,
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

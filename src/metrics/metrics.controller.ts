import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { CalculateMetricsDto } from './dto/calculate-metrics.dto';
import { MetricQueryDto } from './dto/metric-query.dto';
import { AuthenticatedUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { throwCapturedAppError } from '../common/monitoring/capture-app-error';
import { CalculationQualityService } from './calculation-quality.service';
import { CalculationSummaryQueryDto } from './dto/calculation-summary-query.dto';

@UseGuards(JwtAuthGuard)
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(MetricsService)
    private readonly metricsService: MetricsService,
    private readonly calculationQualityService: CalculationQualityService,
  ) {}

  @Post('calculate')
  async calculate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CalculateMetricsDto,
  ) {
    try {
      return await this.metricsService.calculate(
        user.organizationId,
        dto,
        user.id,
      );
    } catch (error) {
      throwCapturedAppError(
        error,
        {
          feature: 'metrics',
          operation: 'calculate',
          userId: user.id,
          userEmail: user.email,
          organizationId: user.organizationId,
          entityType: 'ActivityData',
          metadata: {
            route: '/api/metrics/calculate',
            method: 'POST',
            activityRecordIds: dto.activityDataIds,
            metricTypes: dto.metricTypes,
          },
        },
        'Metrics could not be calculated. Please try again.',
      );
    }
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MetricQueryDto,
  ) {
    return this.metricsService.findAll(user.organizationId, query);
  }

  @Get('summary')
  async summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MetricQueryDto,
  ) {
    try {
      return await this.metricsService.getSummary(user.organizationId, query);
    } catch (error) {
      throwCapturedAppError(
        error,
        {
          feature: 'metrics',
          operation: 'summary-aggregation',
          userId: user.id,
          userEmail: user.email,
          organizationId: user.organizationId,
          metadata: {
            route: '/api/metrics/summary',
            method: 'GET',
            facilityId: query.facilityId,
            metricType: query.metricType,
            periodStart: query.periodStart,
            periodEnd: query.periodEnd,
          },
        },
        'Metrics summary could not be calculated.',
      );
    }
  }

  @Get('calculation-summary')
  calculationSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CalculationSummaryQueryDto,
  ) {
    return this.calculationQualityService.buildSummary(
      user.organizationId,
      query,
    );
  }
}

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

@UseGuards(JwtAuthGuard)
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(MetricsService)
    private readonly metricsService: MetricsService,
  ) {}

  @Post('calculate')
  calculate(@CurrentUser() user: AuthenticatedUser, @Body() dto: CalculateMetricsDto) {
    return this.metricsService.calculate(user.organizationId, dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MetricQueryDto,
  ) {
    return this.metricsService.findAll(user.organizationId, query);
  }

  @Get('summary')
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MetricQueryDto,
  ) {
    return this.metricsService.getSummary(user.organizationId, query);
  }
}

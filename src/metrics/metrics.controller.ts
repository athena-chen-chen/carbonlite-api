import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { CalculateMetricsDto } from './dto/calculate-metrics.dto';
import { MetricQueryDto } from './dto/metric-query.dto';

@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(MetricsService)
    private readonly metricsService: MetricsService,
  ) {}

  @Post('calculate')
  calculate(@Body() dto: CalculateMetricsDto) {
    return this.metricsService.calculate(dto);
  }

  @Get()
  findAll(@Query() query: MetricQueryDto) {
    return this.metricsService.findAll(query);
  }

  @Get('summary')
  summary(@Query() query: MetricQueryDto) {
    return this.metricsService.getSummary(query);
  }
}
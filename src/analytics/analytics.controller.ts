// api/src/analytics/analytics.controller.ts
import { Controller, Get } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  // @Get('dashboard')
  // getDashboard() {
  //   return this.analytics.getDashboardSummary();
  // }
}

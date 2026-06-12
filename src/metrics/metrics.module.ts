import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ActivityDataModule } from '../activity-data/activity-data.module';
import { CalculationQualityService } from './calculation-quality.service';

@Module({
  imports: [PrismaModule, ActivityDataModule],
  controllers: [MetricsController],
  providers: [MetricsService, CalculationQualityService],
  exports: [MetricsService, CalculationQualityService],
})
export class MetricsModule {}

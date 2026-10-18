import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CalculationModule } from './calculation.module';
import { CalculationQualityService } from './calculation-quality.service';

@Module({
  imports: [PrismaModule, CalculationModule],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService, CalculationModule],
})
export class MetricsModule {}

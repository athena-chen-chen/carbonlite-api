import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { ActivityDataModule } from './activity-data/activity-data.module';
import { MetricsModule } from './metrics/metrics.module';
import { HealthController } from './health.controller';
import { ConversionFactorsModule } from './conversion-factors/conversion-factors.module';
import { DocumentsModule } from './documents/documents.module';
import { DocumentExtractionModule } from './document-extraction/document-extraction.module';
import { AuthModule } from './auth/auth.module';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ActivityDataModule,
    MetricsModule,
    ConversionFactorsModule,
    DocumentsModule,
    DocumentExtractionModule,
    ReportsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

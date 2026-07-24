import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { ActivityDataModule } from './activity-data/activity-data.module';
import { MetricsModule } from './metrics/metrics.module';
import { HealthController } from './health.controller';
import { ConversionFactorsModule } from './conversion-factors/conversion-factors.module';
import { FactorsModule } from './conversion-factors/factors.module';
import { FactorSourcesModule } from './conversion-factors/factor-sources.module';
import { DocumentsModule } from './documents/documents.module';
import { DocumentExtractionModule } from './document-extraction/document-extraction.module';
import { AuthModule } from './auth/auth.module';
import { ReportsModule } from './reports/reports.module';
import { FeedbackModule } from './feedback/feedback.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { ActivityTrackingModule } from './activity-tracking/activity-tracking.module';
import { SentryTestController } from './sentry-test.controller';
import { FacilitiesModule } from './facilities/facilities.module';

@Module({
  imports: [
    PrismaModule,
    AuditLogModule,
    ActivityTrackingModule,
    AuthModule,
    ActivityDataModule,
    MetricsModule,
    ConversionFactorsModule,
    FactorsModule,
    FactorSourcesModule,
    DocumentsModule,
    DocumentExtractionModule,
    ReportsModule,
    FeedbackModule,
    FacilitiesModule,
  ],
  controllers: [HealthController, SentryTestController],
})
export class AppModule {}

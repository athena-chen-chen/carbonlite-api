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
import { OrganizationsModule } from './organizations/organizations.module';
import { SpreadsheetImportModule } from './spreadsheet-import/spreadsheet-import.module';
import { DocumentStorageModule } from './documents/document-storage.module';
import { WorkspaceErasureModule } from './workspace-erasure/workspace-erasure.module';
import { CustomerProvisioningModule } from './customer-provisioning/customer-provisioning.module';
import { OrganizationQuotasModule } from './organization-quotas/organization-quotas.module';
import { AiAuthorizationModule } from './ai-authorization/ai-authorization.module';
import { LegalHoldsModule } from './legal-holds/legal-holds.module';
import { DeletionRecoveryModule } from './deletion-recovery/deletion-recovery.module';

@Module({
  imports: [
    PrismaModule,
    AuditLogModule,
    ActivityTrackingModule,
    DocumentStorageModule,
    WorkspaceErasureModule,
    CustomerProvisioningModule,
    OrganizationQuotasModule,
    AiAuthorizationModule,
    LegalHoldsModule,
    DeletionRecoveryModule,
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
    OrganizationsModule,
    SpreadsheetImportModule,
  ],
  controllers: [HealthController, SentryTestController],
})
export class AppModule {}

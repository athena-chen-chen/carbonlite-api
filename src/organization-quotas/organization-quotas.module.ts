import { Global, Module } from '@nestjs/common';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import {
  AdminOrganizationQuotaController,
  OrganizationQuotaController,
} from './organization-quotas.controller';
import { OrganizationQuotasService } from './organization-quotas.service';

@Global()
@Module({
  controllers: [OrganizationQuotaController, AdminOrganizationQuotaController],
  providers: [OrganizationQuotasService, PlatformAdminGuard],
  exports: [OrganizationQuotasService],
})
export class OrganizationQuotasModule {}

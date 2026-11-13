import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import {
  AdminRealDataAuthorizationController,
  OrganizationRealDataAuthorizationStatusController,
} from './real-data-authorization.controller';
import { RealDataAuthorizationService } from './real-data-authorization.service';

@Module({
  imports: [PrismaModule, AuditLogModule, AuthModule],
  controllers: [
    OrganizationRealDataAuthorizationStatusController,
    AdminRealDataAuthorizationController,
  ],
  providers: [RealDataAuthorizationService, PlatformAdminGuard],
  exports: [RealDataAuthorizationService],
})
export class RealDataAuthorizationModule {}

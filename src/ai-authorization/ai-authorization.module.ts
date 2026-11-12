import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AuthModule } from '../auth/auth.module';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { PrismaModule } from '../prisma/prisma.module';
import {
  AiAuthorizationController,
  OrganizationAiAuthorizationController,
} from './ai-authorization.controller';
import { AiAuthorizationService } from './ai-authorization.service';

@Module({
  imports: [PrismaModule, AuditLogModule, AuthModule],
  controllers: [AiAuthorizationController, OrganizationAiAuthorizationController],
  providers: [AiAuthorizationService, PlatformAdminGuard],
  exports: [AiAuthorizationService],
})
export class AiAuthorizationModule {}

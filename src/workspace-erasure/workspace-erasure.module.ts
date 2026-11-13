import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { WorkspaceErasureController } from './workspace-erasure.controller';
import { WorkspaceErasureService } from './workspace-erasure.service';
import { RealDataAuthorizationModule } from '../real-data-authorization/real-data-authorization.module';

@Module({
  imports: [PrismaModule, RealDataAuthorizationModule],
  controllers: [WorkspaceErasureController],
  providers: [WorkspaceErasureService, PlatformAdminGuard],
})
export class WorkspaceErasureModule {}

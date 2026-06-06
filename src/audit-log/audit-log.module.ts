import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogController } from './audit-log.controller';
import { AuditLogService } from './audit-log.service';
import { RolesGuard } from '../auth/guards/roles.guard';

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [AuditLogController],
  providers: [AuditLogService, RolesGuard],
  exports: [AuditLogService],
})
export class AuditLogModule {}

import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RolesGuard } from '../auth/guards/roles.guard';
import { FactorSourcesController } from './factor-sources.controller';
import { FactorSourcesService } from './factor-sources.service';

@Module({
  imports: [PrismaModule, AuditLogModule],
  controllers: [FactorSourcesController],
  providers: [FactorSourcesService, RolesGuard],
  exports: [FactorSourcesService],
})
export class FactorSourcesModule {}

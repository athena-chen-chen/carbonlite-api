import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DeletionRecoveryService } from './deletion-recovery.service';
import { ExecutePurgeDto, PurgeDryRunDto, StorageReconciliationDto } from './dto/deletion-recovery.dto';

@Controller('admin/storage-reconciliation')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class DeletionRecoveryController {
  constructor(private readonly recovery: DeletionRecoveryService) {}

  @Post('report')
  report(@CurrentUser() actor: AuthenticatedUser, @Body() dto: StorageReconciliationDto) {
    return this.recovery.reconcile(actor, dto.organizationId);
  }

  @Post('purge/dry-run')
  purgeDryRun(@CurrentUser() actor: AuthenticatedUser, @Body() dto: PurgeDryRunDto) {
    return this.recovery.purgeDryRun(actor, dto.candidateIds);
  }

  @Post('purge')
  purge(@CurrentUser() actor: AuthenticatedUser, @Body() dto: ExecutePurgeDto) {
    return this.recovery.purge(actor, dto.candidateIds, dto.reviewToken, dto.confirmPurge);
  }
}

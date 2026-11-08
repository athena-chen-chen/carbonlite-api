import { Global, Module } from '@nestjs/common';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { DeletionRecoveryController } from './deletion-recovery.controller';
import { DeletionRecoveryService } from './deletion-recovery.service';

@Global()
@Module({
  controllers: [DeletionRecoveryController],
  providers: [DeletionRecoveryService, PlatformAdminGuard],
  exports: [DeletionRecoveryService],
})
export class DeletionRecoveryModule {}

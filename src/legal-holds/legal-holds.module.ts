import { Global, Module } from '@nestjs/common';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { LegalHoldsController } from './legal-holds.controller';
import { LegalHoldsService } from './legal-holds.service';

@Global()
@Module({
  controllers: [LegalHoldsController],
  providers: [LegalHoldsService, PlatformAdminGuard],
  exports: [LegalHoldsService],
})
export class LegalHoldsModule {}

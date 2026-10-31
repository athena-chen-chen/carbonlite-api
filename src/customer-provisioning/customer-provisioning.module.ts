import { Module } from '@nestjs/common';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomerProvisioningController } from './customer-provisioning.controller';
import { CustomerProvisioningService } from './customer-provisioning.service';

@Module({
  imports: [PrismaModule],
  controllers: [CustomerProvisioningController],
  providers: [CustomerProvisioningService, PlatformAdminGuard],
})
export class CustomerProvisioningModule {}

import { Module } from '@nestjs/common';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomerProvisioningController } from './customer-provisioning.controller';
import { CustomerProvisioningService } from './customer-provisioning.service';
import { RealDataAuthorizationModule } from '../real-data-authorization/real-data-authorization.module';

@Module({
  imports: [PrismaModule, RealDataAuthorizationModule],
  controllers: [CustomerProvisioningController],
  providers: [CustomerProvisioningService, PlatformAdminGuard],
})
export class CustomerProvisioningModule {}

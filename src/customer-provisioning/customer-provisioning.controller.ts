import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CustomerProvisioningService } from './customer-provisioning.service';
import { CleanupGoldenSampleDto } from './dto/cleanup-golden-sample.dto';
import { ProvisionPaidPilotDto } from './dto/provision-paid-pilot.dto';

@Controller('admin/customer-provisioning')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class CustomerProvisioningController {
  constructor(private readonly provisioning: CustomerProvisioningService) {}

  @Post('paid-pilot')
  provisionPaidPilot(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ProvisionPaidPilotDto,
  ) {
    return this.provisioning.provisionPaidPilotOrganization(user, dto);
  }

  @Post('golden-sample-cleanup')
  cleanupGoldenSample(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CleanupGoldenSampleDto,
  ) {
    return this.provisioning.cleanupGoldenSampleArtifacts(user, dto);
  }
}

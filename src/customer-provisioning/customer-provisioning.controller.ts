import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CustomerProvisioningService } from './customer-provisioning.service';
import { CleanupGoldenSampleDto } from './dto/cleanup-golden-sample.dto';
import { ProvisionPaidPilotDto } from './dto/provision-paid-pilot.dto';
import { CustomerPreflightQueryDto } from './dto/customer-preflight-query.dto';
import { SuspendCustomerOrganizationDto } from './dto/suspend-customer-organization.dto';

@Controller('admin/customer-provisioning')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class CustomerProvisioningController {
  constructor(private readonly provisioning: CustomerProvisioningService) {}

  @Get('preflight')
  preflight(@Query() query: CustomerPreflightQueryDto) {
    return this.provisioning.getCustomerPreflight(query);
  }

  @Post('paid-pilot')
  provisionPaidPilot(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ProvisionPaidPilotDto,
  ) {
    return this.provisioning.provisionPaidPilotOrganization(user, dto);
  }

  @Post('suspend')
  suspendCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SuspendCustomerOrganizationDto,
  ) {
    return this.provisioning.suspendCustomerOrganization(user, dto);
  }

  @Post('golden-sample-cleanup')
  cleanupGoldenSample(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CleanupGoldenSampleDto,
  ) {
    return this.provisioning.cleanupGoldenSampleArtifacts(user, dto);
  }
}

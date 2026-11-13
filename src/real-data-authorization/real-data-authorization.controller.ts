import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApproveRealDataAuthorizationDto } from './dto/approve-real-data-authorization.dto';
import { WithdrawRealDataAuthorizationDto } from './dto/withdraw-real-data-authorization.dto';
import { RealDataAuthorizationService } from './real-data-authorization.service';

@Controller('real-data-authorization')
@UseGuards(JwtAuthGuard)
export class OrganizationRealDataAuthorizationStatusController {
  constructor(private readonly authorizations: RealDataAuthorizationService) {}

  @Get('status')
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.authorizations.getCustomerStatus(user.organizationId);
  }
}

@Controller('admin/organizations/:organizationId/real-data-authorization')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminRealDataAuthorizationController {
  constructor(private readonly authorizations: RealDataAuthorizationService) {}

  @Get()
  get(@Param('organizationId') organizationId: string) {
    return this.authorizations.getForAdmin(organizationId);
  }

  @Put()
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId') organizationId: string,
    @Body() dto: ApproveRealDataAuthorizationDto,
  ) {
    return this.authorizations.approve(organizationId, user.id, dto);
  }

  @Post('withdraw')
  withdraw(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId') organizationId: string,
    @Body() dto: WithdrawRealDataAuthorizationDto,
  ) {
    return this.authorizations.withdraw(organizationId, user.id, dto);
  }
}

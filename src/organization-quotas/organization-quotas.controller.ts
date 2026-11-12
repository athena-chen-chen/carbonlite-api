import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UpdateOrganizationQuotaDto } from './dto/update-organization-quota.dto';
import { OrganizationQuotasService } from './organization-quotas.service';

@Controller('organization-quota')
@UseGuards(JwtAuthGuard)
export class OrganizationQuotaController {
  constructor(private readonly quotas: OrganizationQuotasService) {}

  @Get()
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.quotas.getStatus(user.organizationId);
  }
}

@Controller('admin/organization-quotas')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminOrganizationQuotaController {
  constructor(private readonly quotas: OrganizationQuotasService) {}

  @Get(':organizationId')
  status(@Param('organizationId') organizationId: string) {
    return this.quotas.getStatus(organizationId);
  }

  @Put(':organizationId')
  configure(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId') organizationId: string,
    @Body() dto: UpdateOrganizationQuotaDto,
  ) {
    return this.quotas.configure(organizationId, user.id, dto);
  }

  @Post(':organizationId/reset')
  reset(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId') organizationId: string,
  ) {
    return this.quotas.reset(organizationId, user.id);
  }
}

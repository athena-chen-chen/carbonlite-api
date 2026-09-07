import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UpdateOrganizationProfileDto } from './dto/update-organization-profile.dto';
import { OrganizationsService } from './organizations.service';

@UseGuards(JwtAuthGuard)
@Controller('organization-profile')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get()
  getProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.organizationsService.getOrganizationProfile(user);
  }

  @Patch()
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateOrganizationProfileDto,
  ) {
    return this.organizationsService.updateOrganizationProfile(user, dto);
  }
}

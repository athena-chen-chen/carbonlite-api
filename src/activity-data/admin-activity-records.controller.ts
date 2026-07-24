import { Body, Controller, Delete, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ActivityDataService } from './activity-data.service';
import { ClearActivityRecordsDto } from './dto/clear-activity-records.dto';
import { ResetDemoDataDto } from './dto/reset-demo-data.dto';

@UseGuards(JwtAuthGuard)
@Controller('admin')
export class AdminActivityRecordsController {
  constructor(private readonly activityDataService: ActivityDataService) {}

  @Delete('activity-records/clear')
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  clearActivityRecords(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ClearActivityRecordsDto,
  ) {
    return this.activityDataService.clearForOrganization(
      user.organizationId,
      user.id,
      dto.confirmation,
    );
  }

  @Post('demo-data/reset')
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  resetDemoData(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ResetDemoDataDto,
  ) {
    return this.activityDataService.resetDemoDataForOrganization(
      user.organizationId,
      user.id,
      dto.confirmation,
    );
  }
}

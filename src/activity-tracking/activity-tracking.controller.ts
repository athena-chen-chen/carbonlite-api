import { Body, Controller, Get, Headers, Post, Query, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ActivityTrackingService } from './activity-tracking.service';
import { ActivityEventQueryDto } from './dto/activity-event-query.dto';
import { CreateActivityEventDto } from './dto/create-activity-event.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '@prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('activity-events')
export class ActivityTrackingController {
  constructor(private readonly activityTracking: ActivityTrackingService) {}

  @Post()
  createClientEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateActivityEventDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.activityTracking.track({
      organizationId: user.organizationId,
      userId: user.id,
      eventName: dto.eventName,
      page: dto.page,
      url: dto.url,
      entityType: dto.entityType,
      entityId: dto.entityId,
      metadata: dto.metadata,
      userAgent,
    });
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ActivityEventQueryDto,
  ) {
    return this.activityTracking.findOwn(user.id, query);
  }

  @Get('summary')
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ActivityEventQueryDto,
  ) {
    return this.activityTracking.getOwnSummary(user.id, query);
  }
}

@UseGuards(JwtAuthGuard)
@Controller('admin/activity')
export class AdminActivityTrackingController {
  constructor(private readonly activityTracking: ActivityTrackingService) {}

  @Get()
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  findAll(@Query() query: ActivityEventQueryDto) {
    return this.activityTracking.findAllAdmin(query);
  }

  @Get('summary')
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  summary(@Query() query: ActivityEventQueryDto) {
    return this.activityTracking.getAdminSummary(query);
  }

  @Get('active-users')
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  activeUsers(@Query() query: ActivityEventQueryDto) {
    return this.activityTracking.getAdminActiveUsers(query);
  }
}

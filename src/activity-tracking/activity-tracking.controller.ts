import { Body, Controller, Get, Headers, Post, Query, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ActivityTrackingService } from './activity-tracking.service';
import { ActivityEventQueryDto } from './dto/activity-event-query.dto';
import { CreateActivityEventDto } from './dto/create-activity-event.dto';

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
    return this.activityTracking.findAll(user.organizationId, query);
  }

  @Get('summary')
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ActivityEventQueryDto,
  ) {
    return this.activityTracking.getSummary(user.organizationId, query);
  }
}

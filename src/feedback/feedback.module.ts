import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminFeedbackController, FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ActivityTrackingModule } from '../activity-tracking/activity-tracking.module';

@Module({
  imports: [PrismaModule, ActivityTrackingModule],
  controllers: [FeedbackController, AdminFeedbackController],
  providers: [FeedbackService, RolesGuard],
})
export class FeedbackModule {}

import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ActivityTrackingController } from './activity-tracking.controller';
import { ActivityTrackingService } from './activity-tracking.service';
import { RolesGuard } from '../auth/guards/roles.guard';

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [ActivityTrackingController],
  providers: [ActivityTrackingService, RolesGuard],
  exports: [ActivityTrackingService],
})
export class ActivityTrackingModule {}

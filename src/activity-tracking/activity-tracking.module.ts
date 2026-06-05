import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ActivityTrackingController } from './activity-tracking.controller';
import { ActivityTrackingService } from './activity-tracking.service';

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [ActivityTrackingController],
  providers: [ActivityTrackingService],
  exports: [ActivityTrackingService],
})
export class ActivityTrackingModule {}

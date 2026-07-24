import { Module } from '@nestjs/common';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminActivityRecordsController } from './admin-activity-records.controller';
import { ActivityDataController } from './activity-data.controller';
import { ActivityDataService } from './activity-data.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ActivityDataController, AdminActivityRecordsController],
  providers: [ActivityDataService, RolesGuard],
  exports: [ActivityDataService],
})
export class ActivityDataModule {}

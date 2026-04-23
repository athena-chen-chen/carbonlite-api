import { Module } from '@nestjs/common';
import { ActivityDataController } from './activity-data.controller';
import { ActivityDataService } from './activity-data.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ActivityDataController],
  providers: [ActivityDataService],
  exports: [ActivityDataService],
})
export class ActivityDataModule {}
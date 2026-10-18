import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CalculationQualityService } from './calculation-quality.service';
import { CalculationSnapshotsService } from './calculation-snapshots.service';
@Module({ imports: [PrismaModule], providers: [CalculationQualityService, CalculationSnapshotsService], exports: [CalculationQualityService, CalculationSnapshotsService] })
export class CalculationModule {}

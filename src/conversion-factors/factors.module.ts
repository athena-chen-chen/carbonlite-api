import { Module } from '@nestjs/common';
import { FactorsController } from './factors.controller';
import { FactorsService } from './factors.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ConversionFactorsService } from './conversion-factors.service';
import { RolesGuard } from '../auth/guards/roles.guard';

@Module({
  imports: [PrismaModule],
  controllers: [FactorsController],
  providers: [FactorsService, ConversionFactorsService, RolesGuard],
  exports: [FactorsService],
})
export class FactorsModule {}

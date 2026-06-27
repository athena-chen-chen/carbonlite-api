import { Module } from '@nestjs/common';
import { ConversionFactorsController } from './conversion-factors.controller';
import { FactorVersionsController } from './factor-versions.controller';
import { ConversionFactorsService } from './conversion-factors.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RolesGuard } from '../auth/guards/roles.guard';

@Module({
  imports: [PrismaModule],
  controllers: [ConversionFactorsController, FactorVersionsController],
  providers: [ConversionFactorsService, RolesGuard],
  exports: [ConversionFactorsService],
})
export class ConversionFactorsModule {}
import { Module } from '@nestjs/common';
import { ConversionFactorsController } from './conversion-factors.controller';
import { ConversionFactorsService } from './conversion-factors.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ConversionFactorsController],
  providers: [ConversionFactorsService],
  exports: [ConversionFactorsService],
})
export class ConversionFactorsModule {}
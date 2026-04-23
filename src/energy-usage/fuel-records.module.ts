// src/fuel-records/fuel-records.module.ts
import { Module } from '@nestjs/common';
import { FuelRecordsService } from './fuel-records.service';
import { FuelRecordsController } from './fuel-records.controller';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [FuelRecordsController],
  providers: [FuelRecordsService, PrismaService],
  exports: [FuelRecordsService],
})
export class FuelRecordsModule {}

// src/facilities/facilities.module.ts
import { Module } from '@nestjs/common';
import { FacilitiesService } from './facilities.service';
import { FacilitiesController } from './facilities.controller';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [FacilitiesController],
  providers: [FacilitiesService, PrismaService],
  exports: [FacilitiesService],
})
export class FacilitiesModule {}

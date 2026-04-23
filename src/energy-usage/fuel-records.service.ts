// src/fuel-records/fuel-records.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateFuelRecordDto } from './dto/create-fuel-record.dto';

@Injectable()
export class FuelRecordsService {
  constructor(private prisma: PrismaService) {}

  // findRecent(limit = 50) {
  //   return this.prisma.fuelRecord.findMany({
  //     orderBy: { date: 'desc' },
  //     take: limit,
  //     include: {
  //       facility: true,
  //       createdBy: {
  //         select: { id: true, email: true, role: true },
  //       },
  //     },
  //   });
  // }

  // async create(dto: CreateFuelRecordDto, userId: string) {
  //   return this.prisma.fuelRecord.create({
  //     data: {
  //       facilityId: dto.facilityId,
  //       fuelType: dto.fuelType,
  //       amount: dto.amount,
  //       unit: dto.unit,
  //       date: new Date(dto.date),
  //       note: dto.note ?? null,
  //       createdById: userId,
  //     },
  //     include: {
  //       facility: true,
  //       createdBy: {
  //         select: { id: true, email: true, role: true },
  //       },
  //     },
  //   });
  // }
}

// api/src/factors/factors.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateFactorDto } from './dto/create-factor.dto';
import { UpdateFactorDto } from './dto/update-conversion-factor.dto';

@Injectable()
export class FactorsService {
  constructor(private prisma: PrismaService) {}

  // findAll() {
  //   return this.prisma.factor.findMany({
  //     orderBy: { updatedAt: 'desc' },
  //     include: {
  //       updatedBy: { select: { id: true, email: true, role: true } },
  //     },
  //   });
  // }

  // create(dto: CreateFactorDto, userId: string | null) {
  //   return this.prisma.factor.create({
  //     data: {
  //       name: dto.name,
  //       scope: dto.scope,
  //       unit: dto.unit,
  //       value: dto.value,
  //       source: dto.source,
  //       method: dto.method ?? null,
  //       updatedById: userId ?? null,
  //     },
  //   });
  // }

  // update(id: string, dto: UpdateFactorDto, userId: string | null) {
  //   return this.prisma.factor.update({
  //     where: { id },
  //     data: {
  //       ...dto,
  //       updatedById: userId ?? null,
  //       updatedAt: new Date(),
  //     },
  //   });
  // }

  // remove(id: string) {
  //   // consider soft-delete later
  //   return this.prisma.factor.delete({ where: { id } });
  // }
}

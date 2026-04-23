// src/facilities/facilities.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FacilitiesService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.facility.findMany({
      orderBy: { name: 'asc' },
    });
  }
}

// src/facilities/facilities.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateFacilityDto } from './dto/create-facility.dto';

@Injectable()
export class FacilitiesService {
  constructor(private prisma: PrismaService) {}

  findAll(organizationId: string) {
    return this.prisma.facility.findMany({
      where: {
        organizationId,
        isActive: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  create(organizationId: string, dto: CreateFacilityDto) {
    return this.prisma.facility.create({
      data: {
        organizationId,
        name: dto.name.trim(),
        code: normalizeOptional(dto.code),
        type: dto.type ?? 'OTHER',
        addressLine1: normalizeOptional(dto.addressLine1),
        addressLine2: normalizeOptional(dto.addressLine2),
        city: normalizeOptional(dto.city),
        provinceState: normalizeProvince(dto.provinceState),
        country: normalizeCountry(dto.country),
        postalCode: normalizeOptional(dto.postalCode),
        latitude: dto.latitude,
        longitude: dto.longitude,
      },
    });
  }

  async update(
    organizationId: string,
    id: string,
    dto: Partial<CreateFacilityDto>,
  ) {
    const existing = await this.prisma.facility.findFirst({
      where: { id, organizationId },
    });

    if (!existing) {
      throw new NotFoundException(`Facility ${id} not found.`);
    }

    return this.prisma.facility.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.code !== undefined ? { code: normalizeOptional(dto.code) } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.addressLine1 !== undefined
          ? { addressLine1: normalizeOptional(dto.addressLine1) }
          : {}),
        ...(dto.addressLine2 !== undefined
          ? { addressLine2: normalizeOptional(dto.addressLine2) }
          : {}),
        ...(dto.city !== undefined ? { city: normalizeOptional(dto.city) } : {}),
        ...(dto.provinceState !== undefined
          ? { provinceState: normalizeProvince(dto.provinceState) }
          : {}),
        ...(dto.country !== undefined ? { country: normalizeCountry(dto.country) } : {}),
        ...(dto.postalCode !== undefined
          ? { postalCode: normalizeOptional(dto.postalCode) }
          : {}),
        ...(dto.latitude !== undefined ? { latitude: dto.latitude } : {}),
        ...(dto.longitude !== undefined ? { longitude: dto.longitude } : {}),
      },
    });
  }
}

function normalizeOptional(value?: string | null) {
  const normalized = value?.trim();
  return normalized || null;
}

function normalizeCountry(value?: string | null) {
  const normalized = value?.trim();
  if (!normalized) return 'Canada';
  if (['ca', 'can', 'canada'].includes(normalized.toLowerCase())) return 'Canada';
  return normalized;
}

function normalizeProvince(value?: string | null) {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ');

  if (!normalized) return null;

  const aliases: Record<string, string> = {
    ab: 'Alberta',
    alta: 'Alberta',
    alberta: 'Alberta',
    bc: 'British Columbia',
    'b c': 'British Columbia',
    'british columbia': 'British Columbia',
    on: 'Ontario',
    ont: 'Ontario',
    ontario: 'Ontario',
  };

  return aliases[normalized] ?? value?.trim() ?? null;
}

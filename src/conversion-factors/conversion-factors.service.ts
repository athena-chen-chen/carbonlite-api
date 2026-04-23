import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ActivityType, FactorType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateConversionFactorDto } from './dto/create-conversion-factor.dto';
import { UpdateConversionFactorDto } from './dto/update-conversion-factor.dto';
import { ConversionFactorQueryDto } from './dto/conversion-factor-query.dto';

@Injectable()
export class ConversionFactorsService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly defaultOrganizationId = 'demo-org-id';

  async create(dto: CreateConversionFactorDto) {
    this.validateDateRange(dto.effectiveFrom, dto.effectiveTo);

    const created = await this.prisma.conversionFactor.create({
      data: {
        organizationId: this.defaultOrganizationId,
        name: dto.name,
        type: dto.type as FactorType,
        activityType: dto.activityType
          ? (dto.activityType as ActivityType)
          : null,
        region: dto.region ?? null,
        country: dto.country ?? null,
        unit: dto.unit,
        factorValue: new Prisma.Decimal(dto.factorValue),
        resultUnit: dto.resultUnit,
        sourceName: dto.sourceName ?? null,
        sourceReference: dto.sourceReference ?? null,
        effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : null,
        effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
        isDefault: dto.isDefault ?? false,
      },
    });

    return created;
  }

  async findAll(query: ConversionFactorQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.ConversionFactorWhereInput = {
      OR: [
        { organizationId: this.defaultOrganizationId },
        { organizationId: null },
      ],
      ...(query.type ? { type: query.type as FactorType } : {}),
      ...(query.activityType
        ? { activityType: query.activityType as ActivityType }
        : {}),
      ...(query.search
        ? {
            AND: [
              {
                OR: [
                  { name: { contains: query.search, mode: 'insensitive' } },
                  { unit: { contains: query.search, mode: 'insensitive' } },
                  { resultUnit: { contains: query.search, mode: 'insensitive' } },
                  {
                    sourceName: {
                      contains: query.search,
                      mode: 'insensitive',
                    },
                  },
                  {
                    sourceReference: {
                      contains: query.search,
                      mode: 'insensitive',
                    },
                  },
                  { region: { contains: query.search, mode: 'insensitive' } },
                  { country: { contains: query.search, mode: 'insensitive' } },
                ],
              },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.conversionFactor.findMany({
        where,
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.conversionFactor.count({ where }),
    ]);

    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async findOne(id: string) {
    const factor = await this.prisma.conversionFactor.findFirst({
      where: {
        id,
        OR: [
          { organizationId: this.defaultOrganizationId },
          { organizationId: null },
        ],
      },
    });

    if (!factor) {
      throw new NotFoundException(`ConversionFactor ${id} not found.`);
    }

    return factor;
  }

  async update(id: string, dto: UpdateConversionFactorDto) {
    await this.ensureExists(id);
    this.validateDateRange(dto.effectiveFrom, dto.effectiveTo);

    const updated = await this.prisma.conversionFactor.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.type !== undefined ? { type: dto.type as FactorType } : {}),
        ...(dto.activityType !== undefined
          ? {
              activityType: dto.activityType
                ? (dto.activityType as ActivityType)
                : null,
            }
          : {}),
        ...(dto.region !== undefined ? { region: dto.region || null } : {}),
        ...(dto.country !== undefined ? { country: dto.country || null } : {}),
        ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
        ...(dto.factorValue !== undefined
          ? { factorValue: new Prisma.Decimal(dto.factorValue) }
          : {}),
        ...(dto.resultUnit !== undefined ? { resultUnit: dto.resultUnit } : {}),
        ...(dto.sourceName !== undefined
          ? { sourceName: dto.sourceName || null }
          : {}),
        ...(dto.sourceReference !== undefined
          ? { sourceReference: dto.sourceReference || null }
          : {}),
        ...(dto.effectiveFrom !== undefined
          ? {
              effectiveFrom: dto.effectiveFrom
                ? new Date(dto.effectiveFrom)
                : null,
            }
          : {}),
        ...(dto.effectiveTo !== undefined
          ? {
              effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
            }
          : {}),
        ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
      },
    });

    return updated;
  }

  async remove(id: string) {
    await this.ensureExists(id);

    await this.prisma.conversionFactor.delete({
      where: { id },
    });

    return {
      id,
      deleted: true,
    };
  }

  private async ensureExists(id: string) {
    const existing = await this.prisma.conversionFactor.findFirst({
      where: {
        id,
        OR: [
          { organizationId: this.defaultOrganizationId },
          { organizationId: null },
        ],
      },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException(`ConversionFactor ${id} not found.`);
    }

    return existing;
  }

  private validateDateRange(
    effectiveFrom?: string | null,
    effectiveTo?: string | null,
  ) {
    if (effectiveFrom && effectiveTo) {
      const from = new Date(effectiveFrom);
      const to = new Date(effectiveTo);

      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new BadRequestException('Invalid effective date range.');
      }

      if (from > to) {
        throw new BadRequestException(
          '`effectiveFrom` must be before or equal to `effectiveTo`.',
        );
      }
    }
  }
}
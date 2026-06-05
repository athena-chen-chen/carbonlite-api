import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ActivityType, FactorType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateConversionFactorDto } from './dto/create-conversion-factor.dto';
import { UpdateConversionFactorDto } from './dto/update-conversion-factor.dto';
import { ConversionFactorQueryDto } from './dto/conversion-factor-query.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ActivityTrackingService } from '../activity-tracking/activity-tracking.service';

@Injectable()
export class ConversionFactorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly activityTracking: ActivityTrackingService,
  ) {}

  async create(organizationId: string, dto: CreateConversionFactorDto, userId?: string) {
    this.validateDateRange(dto.effectiveFrom, dto.effectiveTo);

    const created = await this.prisma.conversionFactor.create({
      data: {
        organizationId,
        isSystemDefault: false,
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
        sourceAuthority: dto.sourceAuthority ?? null,
        sourceDocument: dto.sourceDocument ?? null,
        sourceYear: dto.sourceYear ?? null,
        sourceUrl: dto.sourceUrl ?? null,
        methodology: dto.methodology ?? null,
        confidenceLevel: dto.confidenceLevel ?? null,
        verified: dto.verified ?? false,
        notes: dto.notes ?? null,
        effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : null,
        effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
        isDefault: dto.isDefault ?? false,
      },
    });

    await this.auditLog.log({
      organizationId,
      userId,
      action: 'CREATE_CONVERSION_FACTOR',
      entityType: 'ConversionFactor',
      entityId: created.id,
      description: `Created conversion factor ${created.name}`,
      newValue: created,
    });

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'CONVERSION_FACTOR_CREATED',
      entityType: 'ConversionFactor',
      entityId: created.id,
      metadata: {
        activityType: created.activityType,
        inputUnit: created.unit,
        type: created.type,
      },
    });

    return created;
  }

  async findAll(organizationId: string, query: ConversionFactorQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.ConversionFactorWhereInput = {
      OR: [
        { isSystemDefault: true },
        { organizationId },
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
        orderBy: [
          { isSystemDefault: 'asc' },
          { isDefault: 'desc' },
          { createdAt: 'desc' },
        ],
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

  async findOne(organizationId: string, id: string) {
    const factor = await this.prisma.conversionFactor.findFirst({
      where: {
        id,
        OR: [
          { isSystemDefault: true },
          { organizationId },
        ],
      },
    });

    if (!factor) {
      throw new NotFoundException(`ConversionFactor ${id} not found.`);
    }

    return factor;
  }

  async update(organizationId: string, id: string, dto: UpdateConversionFactorDto, userId?: string) {
    const existing = await this.ensureEditable(organizationId, id);
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
        ...(dto.sourceAuthority !== undefined
          ? { sourceAuthority: dto.sourceAuthority || null }
          : {}),
        ...(dto.sourceDocument !== undefined
          ? { sourceDocument: dto.sourceDocument || null }
          : {}),
        ...(dto.sourceYear !== undefined
          ? { sourceYear: dto.sourceYear ?? null }
          : {}),
        ...(dto.sourceUrl !== undefined
          ? { sourceUrl: dto.sourceUrl || null }
          : {}),
        ...(dto.methodology !== undefined
          ? { methodology: dto.methodology || null }
          : {}),
        ...(dto.confidenceLevel !== undefined
          ? { confidenceLevel: dto.confidenceLevel || null }
          : {}),
        ...(dto.verified !== undefined ? { verified: dto.verified } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
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
        isSystemDefault: false,
      },
    });

    await this.auditLog.log({
      organizationId,
      userId,
      action: 'UPDATE_CONVERSION_FACTOR',
      entityType: 'ConversionFactor',
      entityId: id,
      description: `Updated conversion factor ${updated.name}`,
      oldValue: existing,
      newValue: updated,
    });

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'CONVERSION_FACTOR_UPDATED',
      entityType: 'ConversionFactor',
      entityId: id,
      metadata: {
        changedFields: Object.keys(dto),
        activityType: updated.activityType,
        inputUnit: updated.unit,
      },
    });

    return updated;
  }

  async remove(organizationId: string, id: string, userId?: string) {
    const existing = await this.ensureEditable(organizationId, id);

    await this.prisma.conversionFactor.delete({
      where: { id },
    });

    await this.auditLog.log({
      organizationId,
      userId,
      action: 'DELETE_CONVERSION_FACTOR',
      entityType: 'ConversionFactor',
      entityId: id,
      description: `Deleted conversion factor ${existing.name}`,
      oldValue: existing,
    });

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'CONVERSION_FACTOR_DELETED',
      entityType: 'ConversionFactor',
      entityId: id,
      metadata: {
        activityType: existing.activityType,
        inputUnit: existing.unit,
        type: existing.type,
      },
    });

    return {
      id,
      deleted: true,
    };
  }

  private async ensureEditable(organizationId: string, id: string) {
    const existing = await this.prisma.conversionFactor.findFirst({
      where: {
        id,
        OR: [{ isSystemDefault: true }, { organizationId }],
      },
    });

    if (!existing) {
      throw new NotFoundException(`ConversionFactor ${id} not found.`);
    }

    if (existing.isSystemDefault) {
      throw new ForbiddenException('System default factors cannot be modified.');
    }

    if (existing.organizationId !== organizationId) {
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

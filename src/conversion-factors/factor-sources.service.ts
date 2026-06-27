import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PublisherType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CreateFactorSourceDto } from './dto/create-factor-source.dto';
import { UpdateFactorSourceDto } from './dto/update-factor-source.dto';

type Actor = {
  userId?: string | null;
  organizationId?: string | null;
};

@Injectable()
export class FactorSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async findAll(query: { includeArchived?: string } = {}) {
    const includeArchived = query.includeArchived === 'true';
    const where: Prisma.FactorSourceWhereInput = includeArchived ? {} : { isActive: true };

    const sources = await this.prisma.factorSource.findMany({
      where,
      include: { _count: { select: { versions: true } } },
      orderBy: [
        { isOfficial: 'desc' },
        { sourceAuthority: 'asc' },
        { sourceYear: 'desc' },
      ],
    });

    return {
      items: sources.map((source) => this.toDto(source)),
      total: sources.length,
    };
  }

  async findOne(id: string) {
    const source = await this.prisma.factorSource.findUnique({
      where: { id },
      include: {
        _count: { select: { versions: true } },
        versions: {
          include: { factor: true },
          orderBy: [{ factorYear: 'desc' }, { updatedAt: 'desc' }],
        },
      },
    });

    if (!source) {
      throw new NotFoundException(`Factor source ${id} not found.`);
    }

    return this.toDto(source);
  }

  async create(dto: CreateFactorSourceDto, actor: Actor = {}) {
    const data = this.toCreateData(dto);
    this.validateSource(data);

    const created = await this.prisma.factorSource.create({
      data,
      include: { _count: { select: { versions: true } } },
    });

    await this.auditLog.log({
      organizationId: actor.organizationId ?? null,
      userId: actor.userId ?? null,
      action: 'CREATE_FACTOR_SOURCE',
      entityType: 'FactorSource',
      entityId: created.id,
      description: `Created factor source ${created.sourceAuthority} ${created.sourceYear}`,
      newValue: created,
    });

    return this.toDto(created);
  }

  async update(id: string, dto: UpdateFactorSourceDto, actor: Actor = {}) {
    const existing = await this.prisma.factorSource.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Factor source ${id} not found.`);
    }

    const data = this.toUpdateData(dto);
    const merged = { ...(existing as Record<string, unknown>), ...(data as Record<string, unknown>) };
    this.validateSource(merged);

    const updated = await this.prisma.factorSource.update({
      where: { id },
      data,
      include: { _count: { select: { versions: true } } },
    });

    await this.auditLog.log({
      organizationId: actor.organizationId ?? null,
      userId: actor.userId ?? null,
      action: 'UPDATE_FACTOR_SOURCE',
      entityType: 'FactorSource',
      entityId: id,
      description: `Updated factor source ${updated.sourceAuthority} ${updated.sourceYear}`,
      oldValue: existing,
      newValue: updated,
    });

    return this.toDto(updated);
  }

  async remove(id: string, actor: Actor = {}) {
    const existing = await this.prisma.factorSource.findUnique({
      where: { id },
      include: { _count: { select: { versions: true } } },
    });

    if (!existing) {
      throw new NotFoundException(`Factor source ${id} not found.`);
    }

    if (existing._count.versions > 0) {
      const archived = await this.prisma.factorSource.update({
        where: { id },
        data: { isActive: false },
        include: { _count: { select: { versions: true } } },
      });

      await this.auditLog.log({
        organizationId: actor.organizationId ?? null,
        userId: actor.userId ?? null,
        action: 'ARCHIVE_FACTOR_SOURCE',
        entityType: 'FactorSource',
        entityId: id,
        description: `Archived factor source ${archived.sourceAuthority} ${archived.sourceYear}`,
        oldValue: existing,
        newValue: archived,
      });

      return {
        archived: true,
        deleted: false,
        usedByFactors: existing._count.versions,
        source: this.toDto(archived),
      };
    }

    await this.prisma.factorSource.delete({ where: { id } });

    await this.auditLog.log({
      organizationId: actor.organizationId ?? null,
      userId: actor.userId ?? null,
      action: 'DELETE_FACTOR_SOURCE',
      entityType: 'FactorSource',
      entityId: id,
      description: `Deleted unused factor source ${existing.sourceAuthority} ${existing.sourceYear}`,
      oldValue: existing,
    });

    return { archived: false, deleted: true, usedByFactors: 0 };
  }

  getTrustLabel(source: { publisherType: PublisherType; isOfficial: boolean }) {
    if (source.publisherType === PublisherType.GOVERNMENT && source.isOfficial) {
      return 'Government Official';
    }

    if (
      source.publisherType === PublisherType.STANDARD_BODY ||
      source.publisherType === PublisherType.INDUSTRY_BODY
    ) {
      return 'Industry Standard';
    }

    if (source.publisherType === PublisherType.CUSTOM || source.publisherType === PublisherType.COMPANY) {
      return 'Custom / Organization Provided';
    }

    return 'Demo / Unverified';
  }

  private toCreateData(dto: CreateFactorSourceDto): Prisma.FactorSourceCreateInput {
    return {
      sourceAuthority: dto.sourceAuthority?.trim(),
      sourceShortName: cleanOptional(dto.sourceShortName),
      sourceDocument: dto.sourceDocument?.trim(),
      sourceVersion: cleanOptional(dto.sourceVersion) ?? '',
      sourceYear: dto.sourceYear ?? 0,
      sourceUrl: cleanOptional(dto.sourceUrl) ?? '',
      page: cleanOptional(dto.page) ?? '',
      tableReference: cleanOptional(dto.tableReference) ?? '',
      publishedDate: dto.publishedDate ? new Date(dto.publishedDate) : new Date(),
      country: cleanOptional(dto.country),
      jurisdictionRegion: cleanOptional(dto.jurisdictionRegion),
      publisherType: dto.publisherType ?? PublisherType.UNKNOWN,
      description: cleanOptional(dto.description),
      notes: cleanOptional(dto.notes) ?? '',
      isOfficial: dto.isOfficial ?? false,
      isActive: dto.isActive ?? true,
    };
  }

  private toUpdateData(dto: UpdateFactorSourceDto): Prisma.FactorSourceUpdateInput {
    return {
      ...(dto.sourceAuthority !== undefined ? { sourceAuthority: dto.sourceAuthority.trim() } : {}),
      ...(dto.sourceShortName !== undefined ? { sourceShortName: cleanOptional(dto.sourceShortName) } : {}),
      ...(dto.sourceDocument !== undefined ? { sourceDocument: dto.sourceDocument.trim() } : {}),
      ...(dto.sourceVersion !== undefined ? { sourceVersion: cleanOptional(dto.sourceVersion) ?? '' } : {}),
      ...(dto.sourceYear !== undefined ? { sourceYear: dto.sourceYear ?? 0 } : {}),
      ...(dto.sourceUrl !== undefined ? { sourceUrl: cleanOptional(dto.sourceUrl) ?? '' } : {}),
      ...(dto.page !== undefined ? { page: cleanOptional(dto.page) ?? '' } : {}),
      ...(dto.tableReference !== undefined ? { tableReference: cleanOptional(dto.tableReference) ?? '' } : {}),
      ...(dto.publishedDate !== undefined ? { publishedDate: dto.publishedDate ? new Date(dto.publishedDate) : new Date() } : {}),
      ...(dto.country !== undefined ? { country: cleanOptional(dto.country) } : {}),
      ...(dto.jurisdictionRegion !== undefined ? { jurisdictionRegion: cleanOptional(dto.jurisdictionRegion) } : {}),
      ...(dto.publisherType !== undefined ? { publisherType: dto.publisherType } : {}),
      ...(dto.description !== undefined ? { description: cleanOptional(dto.description) } : {}),
      ...(dto.notes !== undefined ? { notes: cleanOptional(dto.notes) ?? '' } : {}),
      ...(dto.isOfficial !== undefined ? { isOfficial: dto.isOfficial } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    };
  }

  private validateSource(source: {
    sourceAuthority?: string | null;
    sourceDocument?: string | null;
    sourceYear?: number | null;
    sourceUrl?: string | null;
    publisherType?: PublisherType | null;
    isOfficial?: boolean | null;
  }) {
    const publisherType = source.publisherType ?? PublisherType.UNKNOWN;

    if (!source.sourceAuthority?.trim()) {
      throw new BadRequestException('Source authority is required.');
    }

    if (!source.sourceDocument?.trim()) {
      throw new BadRequestException('Source document is required.');
    }

    if (source.sourceUrl && !isValidUrl(source.sourceUrl)) {
      throw new BadRequestException('Source URL must be a valid URL.');
    }

    if (source.isOfficial) {
      if (!source.sourceYear) {
        throw new BadRequestException('Official source year is required.');
      }

      if (!source.sourceUrl?.trim()) {
        throw new BadRequestException('Official source URL is required.');
      }

      if (publisherType === PublisherType.UNKNOWN) {
        throw new BadRequestException('Official source publisher type cannot be UNKNOWN.');
      }
    }

    if (publisherType === PublisherType.GOVERNMENT && !source.sourceAuthority?.trim()) {
      throw new BadRequestException('Government source authority is required.');
    }
  }

  private toDto(source: any) {
    return {
      id: source.id,
      sourceAuthority: source.sourceAuthority,
      sourceShortName: source.sourceShortName,
      sourceDocument: source.sourceDocument,
      sourceVersion: source.sourceVersion,
      sourceYear: source.sourceYear,
      sourceUrl: source.sourceUrl,
      page: source.page,
      tableReference: source.tableReference,
      publishedDate: source.publishedDate,
      country: source.country,
      jurisdictionRegion: source.jurisdictionRegion,
      publisherType: source.publisherType,
      description: source.description,
      notes: source.notes,
      isOfficial: source.isOfficial,
      isActive: source.isActive,
      trustLabel: this.getTrustLabel(source),
      usedByFactors: source._count?.versions ?? 0,
      linkedFactorVersions: source.versions?.map((version: any) => ({
        id: version.id,
        factorId: version.factorId,
        factorName: version.factor?.displayName,
        activityType: version.factor?.activityType,
        version: version.version,
        factorYear: version.factorYear,
        status: version.status,
        confidenceLevel: version.confidenceLevel,
      })),
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    };
  }
}

function cleanOptional(value?: string | null) {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function isValidUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

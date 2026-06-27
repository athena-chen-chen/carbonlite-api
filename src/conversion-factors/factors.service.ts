import { Injectable, NotFoundException } from '@nestjs/common';
import { FactorStatus, Prisma, PublisherType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FactorsService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: { includeArchived?: string } = {}) {
    const includeArchived = query.includeArchived === 'true';
    const where: Prisma.FactorVersionWhereInput = includeArchived
      ? {}
      : { status: { notIn: ['DEPRECATED', 'ARCHIVED'] as FactorStatus[] } };

    const versions = await this.prisma.factorVersion.findMany({
      where,
      include: {
        factor: true,
        source: true,
      },
      orderBy: [
        { factor: { activityType: 'asc' } },
        { factorYear: 'desc' },
        { updatedAt: 'desc' },
      ],
    });

    return {
      items: versions.map((version) => this.toDto(version)),
      total: versions.length,
    };
  }

  async findOne(id: string) {
    const version = await this.prisma.factorVersion.findUnique({
      where: { id },
      include: {
        factor: true,
        source: true,
      },
    });

    if (!version) {
      throw new NotFoundException(`Factor ${id} not found.`);
    }

    return this.toDto(version);
  }

  private toDto(version: Prisma.FactorVersionGetPayload<{ include: { factor: true; source: true } }>) {
    return {
      id: version.id,
      factorId: version.factorId,
      activityType: version.factor.activityType,
      displayName: version.factor.displayName,
      category: version.factor.category,
      scope: version.factor.scope,
      version: version.version,
      factorValue: Number(version.factorValue),
      inputUnit: version.inputUnit,
      resultUnit: version.resultUnit,
      jurisdictionCountry: version.jurisdictionCountry,
      jurisdictionRegion: version.jurisdictionRegion,
      factorYear: version.factorYear,
      effectiveFrom: version.effectiveFrom,
      effectiveTo: version.effectiveTo,
      status: version.status,
      confidenceLevel: version.confidenceLevel,
      verified: version.verified,
      reviewedBy: version.reviewedBy,
      reviewedAt: version.reviewedAt,
      approvalSource: version.approvalSource,
      reviewNotes: version.reviewNotes,
      governance: {
        status: version.status,
        confidenceLevel: version.confidenceLevel,
        verified: version.verified,
        reviewedBy: version.reviewedBy,
        reviewedAt: version.reviewedAt,
        approvalSource: version.approvalSource,
        reviewNotes: version.reviewNotes,
      },
      source: {
        id: version.source.id,
        sourceAuthority: version.source.sourceAuthority,
        sourceShortName: version.source.sourceShortName,
        sourceDocument: version.source.sourceDocument,
        sourceVersion: version.source.sourceVersion,
        sourceYear: version.source.sourceYear,
        sourceUrl: version.source.sourceUrl,
        page: version.source.page,
        tableReference: version.source.tableReference,
        sourcePage: version.sourcePage ?? version.source.sourcePage,
        sourceSection: version.sourceSection,
        sourceTable: version.sourceTable ?? version.source.sourceTable,
        sourceRow: version.sourceRow,
        sourceColumn: version.sourceColumn,
        citationText: version.citationText,
        publishedDate: version.source.publishedDate,
        country: version.source.country,
        jurisdictionRegion: version.source.jurisdictionRegion,
        publisherType: version.source.publisherType,
        isOfficial: version.source.isOfficial,
        isActive: version.source.isActive,
        trustLabel: getTrustLabel(version.source.publisherType, version.source.isOfficial),
        notes: version.source.notes,
      },
      notes: version.notes,
      createdAt: version.createdAt,
      updatedAt: version.updatedAt,
    };
  }
}


function getTrustLabel(publisherType: PublisherType, isOfficial: boolean) {
  if (publisherType === 'GOVERNMENT' && isOfficial) return 'Government Official';
  if (publisherType === 'STANDARD_BODY' || publisherType === 'INDUSTRY_BODY') return 'Industry Standard';
  if (publisherType === 'CUSTOM' || publisherType === 'COMPANY') return 'Custom / Organization Provided';
  return 'Demo / Unverified';
}

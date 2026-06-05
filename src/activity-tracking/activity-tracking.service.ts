import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityEventQueryDto } from './dto/activity-event-query.dto';

type ActivityTrackInput = {
  eventName: string;
  organizationId?: string | null;
  userId?: string | null;
  page?: string | null;
  url?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: unknown;
  userAgent?: string | null;
};

const SENSITIVE_KEY_PATTERN = /password|token|secret|content|extractedtext|filedata|base64|rawtext/i;

@Injectable()
export class ActivityTrackingService {
  constructor(private readonly prisma: PrismaService) {}

  async track(input: ActivityTrackInput) {
    return this.prisma.userActivityEvent.create({
      data: {
        organizationId: input.organizationId ?? null,
        userId: input.userId ?? null,
        eventName: input.eventName,
        page: input.page ?? null,
        url: input.url ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        metadata: this.toSafeJson(input.metadata),
        userAgent: input.userAgent ?? null,
      },
    });
  }

  async findAll(organizationId: string, query: ActivityEventQueryDto) {
    const page = Number.isFinite(query.page) && query.page ? query.page : 1;
    const pageSize =
      Number.isFinite(query.pageSize) && query.pageSize
        ? Math.min(query.pageSize, 100)
        : 20;
    const skip = (page - 1) * pageSize;
    const where = this.buildWhere(organizationId, query);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.userActivityEvent.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.userActivityEvent.count({ where }),
    ]);

    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getSummary(organizationId: string, query: ActivityEventQueryDto) {
    const where = this.buildWhere(organizationId, query);
    const activeUsers = await this.prisma.userActivityEvent.findMany({
      where: {
        ...where,
        userId: { not: null },
      },
      distinct: ['userId'],
      select: { userId: true },
    });

    const countEvent = (eventName: string) =>
      this.prisma.userActivityEvent.count({
        where: {
          ...where,
          eventName,
        },
      });

    const [
      documentsUploaded,
      extractionAttempts,
      successfulExtractions,
      reportsGenerated,
      pdfExports,
      feedbackSubmitted,
    ] = await Promise.all([
      countEvent('DOCUMENT_UPLOADED'),
      countEvent('DOCUMENT_EXTRACT_STARTED'),
      countEvent('DOCUMENT_EXTRACT_SUCCEEDED'),
      countEvent('REPORT_GENERATED'),
      countEvent('REPORT_EXPORTED_PDF'),
      countEvent('FEEDBACK_SUBMITTED'),
    ]);

    return {
      activeUsers: activeUsers.length,
      documentsUploaded,
      extractionAttempts,
      successfulExtractions,
      reportsGenerated,
      pdfExports,
      feedbackSubmitted,
    };
  }

  private buildWhere(
    organizationId: string,
    query: ActivityEventQueryDto,
  ): Prisma.UserActivityEventWhereInput {
    return {
      organizationId,
      ...(query.eventName ? { eventName: query.eventName } : {}),
      ...(query.pagePath ? { page: query.pagePath } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
            },
          }
        : {}),
      ...(query.user
        ? {
            OR: [
              { userId: { contains: query.user, mode: 'insensitive' } },
              { user: { email: { contains: query.user, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
  }

  private toSafeJson(value: unknown) {
    if (value === undefined) return undefined;

    return JSON.parse(JSON.stringify(this.sanitizeMetadata(value))) as Prisma.InputJsonValue;
  }

  private sanitizeMetadata(value: unknown, depth = 0): unknown {
    if (depth > 3) return '[truncated]';
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
      return value.length > 500 ? `${value.slice(0, 500)}...` : value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => this.sanitizeMetadata(item, depth + 1));
    }

    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !SENSITIVE_KEY_PATTERN.test(key))
          .slice(0, 30)
          .map(([key, item]) => [key, this.sanitizeMetadata(item, depth + 1)]),
      );
    }

    return String(value);
  }
}

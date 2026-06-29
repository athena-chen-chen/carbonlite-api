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
    return this.findMany(this.buildWhere({ organizationId }, query), query);
  }

  async findOwn(userId: string, query: ActivityEventQueryDto) {
    return this.findMany(this.buildWhere({ userId }, query), query);
  }

  async findAllAdmin(query: ActivityEventQueryDto) {
    return this.findMany(this.buildWhere({}, query), query);
  }

  private async findMany(
    where: Prisma.UserActivityEventWhereInput,
    query: ActivityEventQueryDto,
  ) {
    const page = Number.isFinite(query.page) && query.page ? query.page : 1;
    const pageSize =
      Number.isFinite(query.pageSize) && query.pageSize
        ? Math.min(query.pageSize, 100)
        : 20;
    const skip = (page - 1) * pageSize;

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
      items: items.map((item) => this.toActivityDto(item)),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getSummary(organizationId: string, query: ActivityEventQueryDto) {
    return this.getSummaryForWhere(this.buildWhere({ organizationId }, query));
  }

  async getOwnSummary(userId: string, query: ActivityEventQueryDto) {
    return this.getSummaryForWhere(this.buildWhere({ userId }, query));
  }

  async getAdminSummary(query: ActivityEventQueryDto) {
    return this.getSummaryForWhere(this.buildWhere({}, query));
  }

  async getAdminActiveUsers(query: ActivityEventQueryDto) {
    const where: Prisma.UserActivityEventWhereInput = {
      userId: { not: null },
      ...(query.organizationId ? { organizationId: query.organizationId } : {}),
      ...this.buildDateRangeWhere(query, true),
    };

    const groupedUsers = await this.prisma.userActivityEvent.groupBy({
      by: ['userId'],
      where,
      _count: { id: true },
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: 'desc' } },
    });

    const userIds = groupedUsers
      .map((item) => item.userId)
      .filter((userId): userId is string => Boolean(userId));

    const [users, recentEvents] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        include: {
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      Promise.all(
        userIds.map((userId) =>
          this.prisma.userActivityEvent.findFirst({
            where: { ...where, userId },
            orderBy: { createdAt: 'desc' },
            select: {
              userId: true,
              eventName: true,
              createdAt: true,
            },
          }),
        ),
      ),
    ]);

    const usersById = new Map(users.map((user) => [user.id, user]));
    const recentByUserId = new Map(
      recentEvents
        .filter((event): event is NonNullable<typeof event> => Boolean(event?.userId))
        .map((event) => [event.userId, event]),
    );

    return {
      items: groupedUsers.map((item) => {
        const userId = item.userId ?? '';
        const user = usersById.get(userId);
        const recent = recentByUserId.get(userId);

        return {
          userId,
          name: user
            ? [user.firstName, user.lastName].filter(Boolean).join(' ') || null
            : null,
          email: user?.email ?? null,
          organizationId: user?.organizationId ?? null,
          organizationName: user?.organization?.name ?? null,
          activityCount: item._count.id,
          lastActiveAt: recent?.createdAt ?? item._max.createdAt,
          mostRecentActivityType: recent?.eventName ?? null,
        };
      }),
    };
  }

  private async getSummaryForWhere(where: Prisma.UserActivityEventWhereInput) {
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
      today,
      thisWeek,
      thisMonth,
    ] = await Promise.all([
      countEvent('DOCUMENT_UPLOADED'),
      countEvent('DOCUMENT_EXTRACT_STARTED'),
      countEvent('DOCUMENT_EXTRACT_SUCCEEDED'),
      countEvent('REPORT_GENERATED'),
      countEvent('REPORT_EXPORTED_PDF'),
      countEvent('FEEDBACK_SUBMITTED'),
      this.prisma.userActivityEvent.count({
        where: { ...where, createdAt: { gte: startOfToday() } },
      }),
      this.prisma.userActivityEvent.count({
        where: { ...where, createdAt: { gte: startOfWeek() } },
      }),
      this.prisma.userActivityEvent.count({
        where: { ...where, createdAt: { gte: startOfMonth() } },
      }),
    ]);

    return {
      today,
      thisWeek,
      thisMonth,
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
    scope: { organizationId?: string; userId?: string },
    query: ActivityEventQueryDto,
  ): Prisma.UserActivityEventWhereInput {
    const eventName = query.activityType || query.eventName;
    const andFilters: Prisma.UserActivityEventWhereInput[] = [];

    if (query.user) {
      andFilters.push({
        OR: [
          { userId: { contains: query.user, mode: 'insensitive' } },
          { user: { email: { contains: query.user, mode: 'insensitive' } } },
          { user: { firstName: { contains: query.user, mode: 'insensitive' } } },
          { user: { lastName: { contains: query.user, mode: 'insensitive' } } },
        ],
      });
    }

    if (query.organization) {
      andFilters.push({
        OR: [
          { organizationId: { contains: query.organization, mode: 'insensitive' } },
          { organization: { name: { contains: query.organization, mode: 'insensitive' } } },
        ],
      });
    }

    return {
      ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
      ...(scope.userId ? { userId: scope.userId } : {}),
      ...(eventName ? { eventName } : {}),
      ...(query.pagePath ? { page: query.pagePath } : {}),
      ...this.buildDateRangeWhere(query),
      ...(andFilters.length ? { AND: andFilters } : {}),
    };
  }

  private buildDateRangeWhere(
    query: ActivityEventQueryDto,
    defaultToThisMonth = false,
  ): Prisma.UserActivityEventWhereInput {
    if (!query.dateFrom && !query.dateTo && !defaultToThisMonth) {
      return {};
    }

    return {
      createdAt: {
        ...(query.dateFrom
          ? { gte: new Date(query.dateFrom) }
          : defaultToThisMonth
            ? { gte: startOfMonth() }
            : {}),
        ...(query.dateTo ? { lte: endOfDay(query.dateTo) } : {}),
      },
    };
  }

  private toActivityDto(
    item: Prisma.UserActivityEventGetPayload<{
      include: {
        user: {
          select: {
            id: true;
            email: true;
            firstName: true;
            lastName: true;
          };
        };
        organization: {
          select: {
            id: true;
            name: true;
          };
        };
      };
    }>,
  ) {
    const metadata = item.metadata as Record<string, unknown> | null;
    const userName = item.user
      ? [item.user.firstName, item.user.lastName].filter(Boolean).join(' ') || null
      : null;

    return {
      ...item,
      activityType: item.eventName,
      userName,
      userEmail: item.user?.email ?? null,
      organizationName: item.organization?.name ?? null,
      description:
        typeof metadata?.description === 'string'
          ? metadata.description
          : describeEvent(item.eventName, item.entityType),
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

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfWeek() {
  const date = startOfToday();
  const day = date.getDay();
  const diff = day === 0 ? 6 : day - 1;
  date.setDate(date.getDate() - diff);
  return date;
}

function startOfMonth() {
  const date = startOfToday();
  date.setDate(1);
  return date;
}

function endOfDay(value: string) {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

function describeEvent(eventName: string, entityType?: string | null) {
  const label = eventName
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

  return entityType ? `${label} for ${entityType}` : label;
}

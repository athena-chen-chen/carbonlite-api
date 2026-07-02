import { Injectable, Logger } from '@nestjs/common';
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
const TEST_USER_EMAIL_PATTERNS = [
  'test',
  'trace-debug',
  'debug',
  'example.com',
  'carbonlite.test',
];
const TEST_ORGANIZATION_NAME_PATTERNS = ['test', 'debug', 'trace debug'];

type ActivityWhereScope = {
  organizationId?: string;
  userId?: string;
};

type ActivityWhereOptions = {
  defaultToThisMonth?: boolean;
  requireUser?: boolean;
};

export function buildAdminActivityWhereFilter(
  query: ActivityEventQueryDto,
  scope: ActivityWhereScope = {},
  options: ActivityWhereOptions = {},
): Prisma.UserActivityEventWhereInput {
  const eventName = query.activityType || query.eventName;
  const andFilters: Prisma.UserActivityEventWhereInput[] = [];
  const organizationId = query.organizationId || scope.organizationId;

  if (query.user) {
    andFilters.push({
      OR: [
        { userId: { contains: query.user, mode: 'insensitive' } },
        { user: { is: { email: { contains: query.user, mode: 'insensitive' } } } },
        { user: { is: { firstName: { contains: query.user, mode: 'insensitive' } } } },
        { user: { is: { lastName: { contains: query.user, mode: 'insensitive' } } } },
      ],
    });
  }

  if (query.organization) {
    andFilters.push({
      OR: [
        { organizationId: { contains: query.organization, mode: 'insensitive' } },
        {
          organization: {
            is: { name: { contains: query.organization, mode: 'insensitive' } },
          },
        },
      ],
    });
  }

  if (query.hideTestAccounts === true) {
    andFilters.push(buildHideTestAccountsWhere());
  }

  return {
    ...(organizationId ? { organizationId } : {}),
    ...(scope.userId ? { userId: scope.userId } : {}),
    ...(options.requireUser ? { userId: { not: null } } : {}),
    ...(eventName ? { eventName } : {}),
    ...(query.pagePath ? { page: query.pagePath } : {}),
    ...buildDateRangeWhere(query, options.defaultToThisMonth),
    ...(andFilters.length ? { AND: andFilters } : {}),
  };
}

function buildHideTestAccountsWhere(): Prisma.UserActivityEventWhereInput {
  return {
    NOT: [
      ...TEST_USER_EMAIL_PATTERNS.map((pattern) => ({
        user: {
          is: {
            email: { contains: pattern, mode: 'insensitive' as const },
          },
        },
      })),
      ...TEST_ORGANIZATION_NAME_PATTERNS.map((pattern) => ({
        organization: {
          is: {
            name: { contains: pattern, mode: 'insensitive' as const },
          },
        },
      })),
    ],
  };
}

function buildDateRangeWhere(
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

@Injectable()
export class ActivityTrackingService {
  private readonly logger = new Logger(ActivityTrackingService.name);

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
    try {
      return await this.findMany(buildAdminActivityWhereFilter(query), query);
    } catch (error) {
      this.logAdminActivityError('findAllAdmin', error);
      throw error;
    }
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
    try {
      return await this.getSummaryForWhere(buildAdminActivityWhereFilter(query));
    } catch (error) {
      this.logAdminActivityError('getAdminSummary', error);
      throw error;
    }
  }

  async getAdminActiveUsers(query: ActivityEventQueryDto) {
    const where = buildAdminActivityWhereFilter(query, {}, {
      defaultToThisMonth: true,
      requireUser: true,
    });

    try {
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

      const [users, recentEvents, firstEvents] = await Promise.all([
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
        Promise.all(
          userIds.map((userId) =>
            this.prisma.userActivityEvent.findFirst({
              where: { userId },
              orderBy: { createdAt: 'asc' },
              select: {
                userId: true,
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
      const firstByUserId = new Map(
        firstEvents
          .filter((event): event is NonNullable<typeof event> => Boolean(event?.userId))
          .map((event) => [event.userId, event]),
      );

      return {
        items: groupedUsers.map((item) => {
            const userId = item.userId ?? '';
            const user = usersById.get(userId);
            const recent = recentByUserId.get(userId);
            const first = firstByUserId.get(userId);
            const email = user?.email ?? null;
            const firstSeenAt = first?.createdAt ?? user?.createdAt ?? null;
            const isTestAccount = this.isTestAccount(email, user?.organization?.name);

            return {
              userId,
              displayName: user
                ? [user.firstName, user.lastName].filter(Boolean).join(' ') || null
                : null,
              name: user
                ? [user.firstName, user.lastName].filter(Boolean).join(' ') || null
                : null,
              email,
              role: user?.role ?? null,
              organizationId: user?.organizationId ?? null,
              organizationName: user?.organization?.name ?? null,
              activityCount: item._count.id,
              firstSeenAt,
              lastActiveAt: recent?.createdAt ?? item._max.createdAt,
              mostRecentActivityType: recent?.eventName ?? null,
              isTestAccount,
            };
          }),
      };
    } catch (error) {
      this.logAdminActivityError('getAdminActiveUsers', error);
      throw error;
    }
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
    const organizations = await this.prisma.userActivityEvent.findMany({
      where: {
        ...where,
        organizationId: { not: null },
      },
      distinct: ['organizationId'],
      select: { organizationId: true },
    });

    const countEvent = (eventName: string) =>
      this.prisma.userActivityEvent.count({
        where: {
          ...where,
          eventName,
        },
      });

    const [
      totalActivities,
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
      this.prisma.userActivityEvent.count({ where }),
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
      totalActivities,
      today,
      todayActivities: today,
      thisWeek,
      thisMonth,
      thisMonthActivities: thisMonth,
      activeUsers: activeUsers.length,
      organizations: organizations.length,
      newUsers: await this.countNewUsers(where),
      documentsUploaded,
      extractionAttempts,
      successfulExtractions,
      reportsGenerated,
      pdfExports,
      feedbackSubmitted,
    };
  }

  private buildWhere(
    scope: ActivityWhereScope,
    query: ActivityEventQueryDto,
  ): Prisma.UserActivityEventWhereInput {
    return buildAdminActivityWhereFilter(query, scope);
  }

  private async countNewUsers(where: Prisma.UserActivityEventWhereInput) {
    const userIds = await this.prisma.userActivityEvent.findMany({
      where: {
        ...where,
        userId: { not: null },
      },
      distinct: ['userId'],
      select: { userId: true },
    });
    const ids = userIds
      .map((item) => item.userId)
      .filter((userId): userId is string => Boolean(userId));

    if (ids.length === 0) return 0;

    const firstEvents = await Promise.all(
      ids.map((userId) =>
        this.prisma.userActivityEvent.findFirst({
          where: { userId },
          orderBy: { createdAt: 'asc' },
          select: { userId: true, createdAt: true },
        }),
      ),
    );

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    return firstEvents.filter((event) => event?.createdAt && event.createdAt >= sevenDaysAgo).length;
  }

  private isTestAccount(email?: string | null, organizationName?: string | null) {
    const normalizedEmail = email?.toLowerCase() ?? '';
    const normalizedOrganizationName = organizationName?.toLowerCase() ?? '';
    return (
      TEST_USER_EMAIL_PATTERNS.some((pattern) => normalizedEmail.includes(pattern)) ||
      TEST_ORGANIZATION_NAME_PATTERNS.some((pattern) =>
        normalizedOrganizationName.includes(pattern),
      )
    );
  }

  private logAdminActivityError(operation: string, error: unknown) {
    if (process.env.NODE_ENV === 'production') return;

    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    this.logger.error(`[AdminActivity] ${operation} failed: ${message}`, stack);
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

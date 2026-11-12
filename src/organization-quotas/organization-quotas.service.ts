import {
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AIJobStatus,
  AIJobType,
  OrganizationQuota,
  OrganizationQuotaPeriod,
  Prisma,
  QuotaUsageType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuotaExceededException } from './quota-errors';
import { UpdateOrganizationQuotaDto } from './dto/update-organization-quota.dto';

const DEFAULT_PERIOD_DAYS = 28;
const DEFAULT_UPLOAD_LIMIT = 20;
const DEFAULT_DAILY_UPLOAD_LIMIT = 10;
const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_EXTRACTIONS = 2;
const DEFAULT_MAX_IMPORT_ROWS = 500;
export const EXTRACTION_LEASE_MS = 2 * 60 * 1000;

type TransactionClient = Prisma.TransactionClient;
type UploadAcceptance<T> = {
  value: T;
  accepted: boolean;
  documentId?: string;
  metadata?: Prisma.InputJsonValue;
};

@Injectable()
export class OrganizationQuotasService {
  constructor(private readonly prisma: PrismaService) {}

  async withUploadTransaction<T>(
    input: {
      organizationId: string;
      userId?: string;
      fileSize?: number | null;
      now?: Date;
    },
    accept: (tx: TransactionClient) => Promise<UploadAcceptance<T>>,
  ): Promise<T> {
    return this.prisma.$transaction((tx) =>
      this.withUploadAcceptance(tx, input, () => accept(tx)),
    );
  }

  async withUploadAcceptance<T>(
    tx: TransactionClient,
    input: {
      organizationId: string;
      userId?: string;
      fileSize?: number | null;
      now?: Date;
    },
    accept: () => Promise<UploadAcceptance<T>>,
  ): Promise<T> {
    await this.lockOrganization(tx, input.organizationId);
    const policy = await tx.organizationQuota.findUnique({
      where: { organizationId: input.organizationId },
      include: {
        organization: {
          select: { isActive: true, customerStatus: true },
        },
      },
    });
    if (policy?.enabled) this.assertUsageAllowed(policy.organization);

    if (
      policy?.enabled &&
      input.fileSize !== null &&
      input.fileSize !== undefined &&
      input.fileSize > policy.maxFileSizeBytes
    ) {
      throw new QuotaExceededException(
        'FILE_SIZE_QUOTA_EXCEEDED',
        'This file exceeds your organization upload size limit.',
        { limit: policy.maxFileSizeBytes },
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    const result = await accept();
    if (!result.accepted || !policy?.enabled) return result.value;

    if (!result.documentId) {
      throw new Error('Accepted uploads must provide a document ID.');
    }

    const now = input.now ?? new Date();
    const period = await this.ensureCurrentPeriod(tx, input.organizationId, policy.periodDays, now);
    const day = await this.organizationDayBounds(tx, input.organizationId, now);
    const [periodUsage, dailyUsage] = await Promise.all([
      tx.organizationQuotaUsage.count({
        where: { periodId: period.id, usageType: QuotaUsageType.DOCUMENT_UPLOAD },
      }),
      tx.organizationQuotaUsage.count({
        where: {
          periodId: period.id,
          usageType: QuotaUsageType.DOCUMENT_UPLOAD,
          occurredAt: { gte: day.startsAt, lte: now },
        },
      }),
    ]);

    if (periodUsage >= policy.uploadLimit) {
      throw new QuotaExceededException(
        'UPLOAD_PERIOD_QUOTA_EXCEEDED',
        'Your organization has reached its upload limit for this quota period.',
        { limit: policy.uploadLimit, remaining: 0, resetAt: period.endsAt },
      );
    }
    if (dailyUsage >= policy.dailyUploadLimit) {
      throw new QuotaExceededException(
        'DAILY_UPLOAD_QUOTA_EXCEEDED',
        'Your organization has reached its daily upload limit.',
        {
          limit: policy.dailyUploadLimit,
          remaining: 0,
          resetAt: day.endsAt,
        },
      );
    }

    await tx.organizationQuotaUsage.create({
      data: {
        organizationId: input.organizationId,
        periodId: period.id,
        userId: input.userId ?? null,
        documentId: result.documentId,
        usageType: QuotaUsageType.DOCUMENT_UPLOAD,
        occurredAt: now,
        metadata: result.metadata,
      },
    });
    return result.value;
  }

  async assertImportRows(organizationId: string, rowCount: number) {
    const policy = await this.prisma.organizationQuota.findUnique({
      where: { organizationId },
      select: {
        enabled: true,
        maxImportRows: true,
        organization: {
          select: { isActive: true, customerStatus: true },
        },
      },
    });
    if (policy?.enabled) this.assertUsageAllowed(policy.organization);
    if (policy?.enabled && rowCount > policy.maxImportRows) {
      throw new QuotaExceededException(
        'IMPORT_ROW_QUOTA_EXCEEDED',
        'This import exceeds your organization row limit.',
        { limit: policy.maxImportRows },
      );
    }
  }

  async beginExtraction(input: {
    organizationId: string;
    documentId: string;
    userId?: string;
    now?: Date;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockOrganization(tx, input.organizationId);
      const policy = await tx.organizationQuota.findUnique({
        where: { organizationId: input.organizationId },
        select: {
          enabled: true,
          maxConcurrentExtractions: true,
          organization: {
            select: { isActive: true, customerStatus: true },
          },
        },
      });
      if (!policy?.enabled) return null;
      this.assertUsageAllowed(policy.organization);

      const now = input.now ?? new Date();
      await tx.aIJob.updateMany({
        where: {
          organizationId: input.organizationId,
          jobType: AIJobType.EXTRACT_ACTIVITY_DATA,
          status: { in: [AIJobStatus.PENDING, AIJobStatus.RUNNING] },
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          status: AIJobStatus.FAILED,
          completedAt: now,
          errorMessage: 'Extraction lease expired before completion.',
        },
      });

      const alreadyRunning = await tx.aIJob.findFirst({
        where: {
          organizationId: input.organizationId,
          documentId: input.documentId,
          jobType: AIJobType.EXTRACT_ACTIVITY_DATA,
          status: { in: [AIJobStatus.PENDING, AIJobStatus.RUNNING] },
          leaseExpiresAt: { gt: now },
        },
        select: { id: true },
      });
      if (alreadyRunning) {
        throw new QuotaExceededException(
          'EXTRACTION_ALREADY_RUNNING',
          'Extraction is already running for this document.',
          { limit: 1 },
          HttpStatus.CONFLICT,
        );
      }

      const running = await tx.aIJob.count({
        where: {
          organizationId: input.organizationId,
          jobType: AIJobType.EXTRACT_ACTIVITY_DATA,
          status: { in: [AIJobStatus.PENDING, AIJobStatus.RUNNING] },
          leaseExpiresAt: { gt: now },
        },
      });
      if (running >= policy.maxConcurrentExtractions) {
        throw new QuotaExceededException(
          'EXTRACTION_CONCURRENCY_EXCEEDED',
          'Your organization already has the maximum number of extraction jobs running.',
          { limit: policy.maxConcurrentExtractions, remaining: 0 },
        );
      }

      return tx.aIJob.create({
        data: {
          organizationId: input.organizationId,
          documentId: input.documentId,
          createdById: input.userId ?? null,
          jobType: AIJobType.EXTRACT_ACTIVITY_DATA,
          status: AIJobStatus.RUNNING,
          startedAt: now,
          leaseExpiresAt: new Date(now.getTime() + EXTRACTION_LEASE_MS),
        },
        select: { id: true },
      });
    });
  }

  async finishExtraction(
    organizationId: string,
    jobId: string | undefined,
    status: 'COMPLETED' | 'FAILED',
    errorMessage?: string,
  ) {
    if (!jobId) return;
    await this.prisma.aIJob.updateMany({
      where: { id: jobId, organizationId, status: AIJobStatus.RUNNING },
      data: {
        status,
        completedAt: new Date(),
        leaseExpiresAt: null,
        errorMessage: status === 'FAILED' ? (errorMessage ?? 'Extraction failed.') : null,
      },
    });
  }

  async getStatus(organizationId: string, now = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockOrganization(tx, organizationId);
      const policy = await tx.organizationQuota.findUnique({ where: { organizationId } });
      if (!policy) return this.disabledStatus();
      if (!policy.enabled) return this.statusResponse(policy, null, 0, 0, 0);

      const period = await this.ensureCurrentPeriod(tx, organizationId, policy.periodDays, now);
      const day = await this.organizationDayBounds(tx, organizationId, now);
      const [periodUsage, dailyUsage, runningExtractions] = await Promise.all([
        tx.organizationQuotaUsage.count({
          where: { periodId: period.id, usageType: QuotaUsageType.DOCUMENT_UPLOAD },
        }),
        tx.organizationQuotaUsage.count({
          where: {
            periodId: period.id,
            usageType: QuotaUsageType.DOCUMENT_UPLOAD,
            occurredAt: { gte: day.startsAt, lte: now },
          },
        }),
        tx.aIJob.count({
          where: {
            organizationId,
            jobType: AIJobType.EXTRACT_ACTIVITY_DATA,
            status: { in: [AIJobStatus.PENDING, AIJobStatus.RUNNING] },
            leaseExpiresAt: { gt: now },
          },
        }),
      ]);
      return this.statusResponse(policy, period, periodUsage, dailyUsage, runningExtractions);
    });
  }

  async configure(
    organizationId: string,
    actorUserId: string,
    dto: UpdateOrganizationQuotaDto,
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockOrganization(tx, organizationId);
      const organization = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { id: true, customerStatus: true },
      });
      if (!organization) throw new NotFoundException('Organization not found.');
      if (
        dto.enabled === true &&
        !['ACTIVE', 'PILOT'].includes(organization.customerStatus)
      ) {
        throw new ConflictException(
          'Quotas can only be enabled for a paid-pilot customer organization.',
        );
      }
      const previous = await tx.organizationQuota.findUnique({ where: { organizationId } });
      const policy = await tx.organizationQuota.upsert({
        where: { organizationId },
        create: { organizationId, ...dto },
        update: dto,
      });
      const currentPeriod = await tx.organizationQuotaPeriod.findFirst({
        where: { organizationId, closedAt: null },
        orderBy: { startsAt: 'desc' },
      });
      if (policy.enabled && !currentPeriod) {
        await tx.organizationQuotaPeriod.create({
          data: {
            organizationId,
            startsAt: now,
            endsAt: addDays(now, policy.periodDays),
          },
        });
      } else if (!policy.enabled && currentPeriod) {
        await tx.organizationQuotaPeriod.update({
          where: { id: currentPeriod.id },
          data: { closedAt: now },
        });
      }
      await tx.auditLog.create({
        data: {
          organizationId,
          userId: actorUserId,
          action: 'ORGANIZATION_QUOTA_CONFIGURED',
          entityType: 'OrganizationQuota',
          entityId: organizationId,
          description: 'Updated organization quota policy.',
          oldValue: previous ? toJson(previous) : undefined,
          newValue: toJson(policy),
        },
      });
      return policy;
    });
  }

  async reset(organizationId: string, actorUserId: string, now = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockOrganization(tx, organizationId);
      const policy = await tx.organizationQuota.findUnique({ where: { organizationId } });
      if (!policy) throw new NotFoundException('Organization quota policy not found.');
      const current = await tx.organizationQuotaPeriod.findFirst({
        where: { organizationId, closedAt: null },
        orderBy: { startsAt: 'desc' },
      });
      if (current) {
        await tx.organizationQuotaPeriod.update({
          where: { id: current.id },
          data: { closedAt: now, resetByUserId: actorUserId },
        });
      }
      const next = policy.enabled
        ? await tx.organizationQuotaPeriod.create({
            data: {
              organizationId,
              startsAt: now,
              endsAt: addDays(now, policy.periodDays),
              resetByUserId: actorUserId,
            },
          })
        : null;
      await tx.auditLog.create({
        data: {
          organizationId,
          userId: actorUserId,
          action: 'ORGANIZATION_QUOTA_RESET',
          entityType: 'OrganizationQuota',
          entityId: organizationId,
          description: 'Reset organization quota period.',
          oldValue: current ? toJson(current) : undefined,
          newValue: next ? toJson(next) : Prisma.JsonNull,
        },
      });
      return this.getStatusWithinTransaction(tx, policy, next, now);
    });
  }

  private async getStatusWithinTransaction(
    tx: TransactionClient,
    policy: OrganizationQuota,
    period: OrganizationQuotaPeriod | null,
    now: Date,
  ) {
    if (!policy.enabled || !period) return this.statusResponse(policy, null, 0, 0, 0);
    const day = await this.organizationDayBounds(tx, policy.organizationId, now);
    const [periodUsage, dailyUsage, running] = await Promise.all([
      tx.organizationQuotaUsage.count({ where: { periodId: period.id, usageType: QuotaUsageType.DOCUMENT_UPLOAD } }),
      tx.organizationQuotaUsage.count({ where: { periodId: period.id, usageType: QuotaUsageType.DOCUMENT_UPLOAD, occurredAt: { gte: day.startsAt, lte: now } } }),
      tx.aIJob.count({ where: { organizationId: policy.organizationId, jobType: AIJobType.EXTRACT_ACTIVITY_DATA, status: { in: [AIJobStatus.PENDING, AIJobStatus.RUNNING] }, leaseExpiresAt: { gt: now } } }),
    ]);
    return this.statusResponse(policy, period, periodUsage, dailyUsage, running);
  }

  private async ensureCurrentPeriod(
    tx: TransactionClient,
    organizationId: string,
    periodDays: number,
    now: Date,
  ) {
    const current = await tx.organizationQuotaPeriod.findFirst({
      where: { organizationId, closedAt: null },
      orderBy: { startsAt: 'desc' },
    });
    if (current && current.endsAt > now) return current;
    if (current) {
      await tx.organizationQuotaPeriod.update({
        where: { id: current.id },
        data: { closedAt: now },
      });
    }
    return tx.organizationQuotaPeriod.create({
      data: { organizationId, startsAt: now, endsAt: addDays(now, periodDays) },
    });
  }

  private async lockOrganization(tx: TransactionClient, organizationId: string) {
    await tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${organizationId}, 0))`;
  }

  private assertUsageAllowed(organization: {
    isActive: boolean;
    customerStatus: string;
  }) {
    if (
      !organization.isActive ||
      !['ACTIVE', 'PILOT'].includes(organization.customerStatus)
    ) {
      throw new ForbiddenException(
        'Organization access is unavailable. Please contact an administrator.',
      );
    }
  }

  private async organizationDayBounds(
    tx: TransactionClient,
    organizationId: string,
    now: Date,
  ) {
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return dayBoundsInTimeZone(now, organization?.timezone || 'UTC');
  }

  private statusResponse(
    policy: {
      enabled: boolean;
      periodDays: number;
      uploadLimit: number;
      dailyUploadLimit: number;
      maxFileSizeBytes: number;
      maxConcurrentExtractions: number;
      maxImportRows: number;
    },
    period: { startsAt: Date; endsAt: Date } | null,
    periodUsage: number,
    dailyUsage: number,
    runningExtractions: number,
  ) {
    return {
      enabled: policy.enabled,
      period: period ? { startsAt: period.startsAt, endsAt: period.endsAt } : null,
      uploads: {
        periodLimit: policy.uploadLimit,
        periodUsed: periodUsage,
        periodRemaining: Math.max(0, policy.uploadLimit - periodUsage),
        dailyLimit: policy.dailyUploadLimit,
        dailyUsed: dailyUsage,
        dailyRemaining: Math.max(0, policy.dailyUploadLimit - dailyUsage),
        maxFileSizeBytes: policy.maxFileSizeBytes,
      },
      extraction: {
        concurrentLimit: policy.maxConcurrentExtractions,
        running: runningExtractions,
        remaining: Math.max(0, policy.maxConcurrentExtractions - runningExtractions),
      },
      importRows: { limit: policy.maxImportRows },
    };
  }

  private disabledStatus() {
    return this.statusResponse(
      {
        enabled: false,
        periodDays: DEFAULT_PERIOD_DAYS,
        uploadLimit: DEFAULT_UPLOAD_LIMIT,
        dailyUploadLimit: DEFAULT_DAILY_UPLOAD_LIMIT,
        maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
        maxConcurrentExtractions: DEFAULT_MAX_CONCURRENT_EXTRACTIONS,
        maxImportRows: DEFAULT_MAX_IMPORT_ROWS,
      },
      null,
      0,
      0,
      0,
    );
  }
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function dayBoundsInTimeZone(now: Date, requestedTimeZone: string) {
  let timeZone = requestedTimeZone;
  let parts: ReturnType<typeof zonedParts>;
  try {
    parts = zonedParts(now, timeZone);
  } catch {
    timeZone = 'UTC';
    parts = zonedParts(now, timeZone);
  }
  const startsAt = zonedDateTimeToUtc(parts.year, parts.month, parts.day, timeZone);
  const nextLocalDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const endsAt = zonedDateTimeToUtc(
    nextLocalDate.getUTCFullYear(),
    nextLocalDate.getUTCMonth() + 1,
    nextLocalDate.getUTCDate(),
    timeZone,
  );
  return { startsAt, endsAt };
}

function zonedDateTimeToUtc(year: number, month: number, day: number, timeZone: string) {
  const target = Date.UTC(year, month - 1, day);
  let candidate = new Date(target);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const displayed = zonedParts(candidate, timeZone);
    const displayedAsUtc = Date.UTC(
      displayed.year,
      displayed.month - 1,
      displayed.day,
      displayed.hour,
      displayed.minute,
      displayed.second,
    );
    candidate = new Date(candidate.getTime() + target - displayedAsUtc);
  }
  return candidate;
}

function zonedParts(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

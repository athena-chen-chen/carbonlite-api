import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LegalHoldStatus, Prisma, UserRole } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { AuthenticatedUser } from '../auth/auth.service';
import { isPlatformAdmin } from '../common/permissions/workspace-permissions';
import { PrismaService } from '../prisma/prisma.service';
import { ActivateLegalHoldDto } from './dto/activate-legal-hold.dto';
import { ReleaseLegalHoldDto, RequestLegalHoldReleaseDto, ReviewLegalHoldReleaseDto } from './dto/release-legal-hold.dto';

const BLOCKING_STATUSES: LegalHoldStatus[] = [
  LegalHoldStatus.PROVISIONAL,
  LegalHoldStatus.ACTIVE,
  LegalHoldStatus.RELEASE_PENDING,
];

export type DeletionGuardInput = {
  organizationId: string;
  operation: string;
  actorUserId?: string;
  organizationWide?: boolean;
  documentIds?: string[];
  allDocuments?: boolean;
  activityIds?: string[];
  allActivities?: boolean;
  reportIds?: string[];
  allReports?: boolean;
  factorIds?: string[];
};

class LegalHoldBlockedError extends ConflictException {
  constructor(
    readonly hold: {
      id: string;
      caseReference: string;
      authorityReference: string;
      evidenceReference: string | null;
    },
  ) {
    super({
      statusCode: 409,
      code: 'LEGAL_HOLD_ACTIVE',
      message: 'Deletion is temporarily restricted.',
    });
  }
}

@Injectable()
export class LegalHoldsService {
  constructor(private readonly prisma: PrismaService) {}

  async withDeletionGuard<T>(
    input: DeletionGuardInput,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockOrganization(tx, input.organizationId);
        await this.assertDeletionAllowed(tx, input);
        return work(tx);
      });
    } catch (error) {
      if (error instanceof LegalHoldBlockedError) {
        await this.recordBlockedAttempt(error, input).catch(() => undefined);
      }
      throw error;
    }
  }

  async guardExistingTransaction<T>(
    tx: Prisma.TransactionClient,
    input: DeletionGuardInput,
    work: () => Promise<T>,
  ) {
    await this.lockOrganization(tx, input.organizationId);
    await this.assertDeletionAllowed(tx, input);
    return work();
  }

  async withOrganizationTransaction<T>(
    organizationId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.withOrganizationLock(organizationId, work);
  }

  async activate(actor: AuthenticatedUser, dto: ActivateLegalHoldDto) {
    this.assertPlatformAdmin(actor);
    return this.withOrganizationLock(dto.organizationId, async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: dto.organizationId },
        select: { id: true },
      });
      if (!organization) {
        const recoveryRecord = await tx.documentDeletionIntent.findFirst({
          where: { organizationId: dto.organizationId, status: { not: 'PURGED' } },
          select: { id: true },
        });
        if (!recoveryRecord) throw new NotFoundException('Organization not found.');
      }
      await this.assertActiveUser(tx, dto.requesterUserId, 'Requester');
      if (dto.approvedByUserId !== actor.id || dto.requesterUserId === actor.id) {
        throw new ForbiddenException('The authenticated approver must be independent from the requester.');
      }
      await this.assertAuthorizedPlatformUser(tx, actor.id);

      const documentIds = [...new Set(dto.documentIds ?? [])];
      if (dto.scopeType === 'DOCUMENT') {
        if (documentIds.length === 0) {
          throw new BadRequestException('A document hold requires at least one document.');
        }
        const [liveDocuments, pendingDeletionDocuments] = await Promise.all([
          tx.document.findMany({
            where: { id: { in: documentIds }, organizationId: dto.organizationId },
            select: { id: true },
          }),
          tx.documentDeletionIntent.findMany({
            where: {
              documentId: { in: documentIds },
              organizationId: dto.organizationId,
              status: { not: 'PURGED' },
            },
            select: { documentId: true },
          }),
        ]);
        const matchingDocuments = new Set([
          ...liveDocuments.map(({ id }) => id),
          ...pendingDeletionDocuments.flatMap(({ documentId }) => documentId ? [documentId] : []),
        ]);
        if (matchingDocuments.size !== documentIds.length) {
          throw new BadRequestException('Every held document must belong to the organization.');
        }
      } else if (documentIds.length > 0) {
        throw new BadRequestException('An organization hold cannot include document mappings.');
      }

      const effectiveAt = new Date();
      const hold = await tx.legalHold.create({
        data: {
          organizationId: dto.organizationId,
          caseReference: dto.caseReference,
          scopeType: dto.scopeType,
          status: dto.status ?? LegalHoldStatus.ACTIVE,
          authorityReference: dto.authorityReference,
          evidenceReference: dto.evidenceReference,
          requestedById: dto.requesterUserId,
          approvedById: dto.approvedByUserId,
          effectiveAt,
          nextReviewAt: dto.nextReviewAt ? new Date(dto.nextReviewAt) : null,
          documents: documentIds.length
            ? {
                create: documentIds.map((documentId) => ({
                  organizationId: dto.organizationId,
                  documentId,
                })),
              }
            : undefined,
        },
        include: { documents: { select: { documentId: true } } },
      });
      await tx.legalHoldEvent.create({
        data: {
          legalHoldId: hold.id,
          organizationIdHash: this.hashOrganizationId(dto.organizationId),
          caseReference: hold.caseReference,
          action: 'ACTIVATED',
          actorUserId: actor.id,
          authorityReference: dto.authorityReference,
          evidenceReference: dto.evidenceReference,
        },
      });
      return hold;
    });
  }

  async list(organizationId: string) {
    return this.prisma.legalHold.findMany({
      where: { organizationId },
      include: { documents: { select: { documentId: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async requestRelease(
    actor: AuthenticatedUser,
    id: string,
    dto: RequestLegalHoldReleaseDto,
  ) {
    this.assertPlatformAdmin(actor);
    const hold = await this.prisma.legalHold.findUnique({ where: { id } });
    if (!hold) throw new NotFoundException('Legal hold not found.');

    return this.withOrganizationLock(hold.organizationId, async (tx) => {
      const current = await tx.legalHold.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Legal hold not found.');
      if (
        current.status !== LegalHoldStatus.ACTIVE &&
        current.status !== LegalHoldStatus.PROVISIONAL
      ) {
        throw new ConflictException('The legal hold is not eligible for release review.');
      }
      const updated = await tx.legalHold.update({
        where: { id },
        data: {
          status: LegalHoldStatus.RELEASE_PENDING,
          releaseRequestedById: actor.id,
          releaseRequestedAt: new Date(),
        },
      });
      await tx.legalHoldEvent.create({
        data: {
          legalHoldId: id,
          organizationIdHash: this.hashOrganizationId(current.organizationId),
          caseReference: current.caseReference,
          action: 'RELEASE_REQUESTED',
          actorUserId: actor.id,
          authorityReference: current.authorityReference,
          evidenceReference: dto.evidenceReference,
        },
      });
      return updated;
    });
  }

  async release(actor: AuthenticatedUser, id: string, dto: ReleaseLegalHoldDto) {
    this.assertPlatformAdmin(actor);
    const hold = await this.prisma.legalHold.findUnique({ where: { id } });
    if (!hold) throw new NotFoundException('Legal hold not found.');

    return this.withOrganizationLock(hold.organizationId, async (tx) => {
      const current = await tx.legalHold.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Legal hold not found.');
      if (current.status !== LegalHoldStatus.RELEASE_PENDING) {
        throw new ConflictException('Release must be requested before review.');
      }
      if (!current.releaseApprovedById || !current.releaseApprovedAt) {
        throw new ConflictException('Release must be independently reviewed before technical release.');
      }
      if (
        actor.id === current.releaseRequestedById ||
        actor.id === current.releaseApprovedById
      ) {
        throw new ForbiddenException('The release operator must be independent from the requester and approver.');
      }
      const releasedAt = new Date();
      const updated = await tx.legalHold.update({
        where: { id },
        data: {
          status: LegalHoldStatus.RELEASED,
          releasedById: actor.id,
          releasedAt,
        },
      });
      await tx.legalHoldEvent.create({
        data: {
          legalHoldId: id,
          organizationIdHash: this.hashOrganizationId(current.organizationId),
          caseReference: current.caseReference,
          action: 'RELEASED',
          actorUserId: actor.id,
          authorityReference: current.releaseAuthorityReference!,
          evidenceReference: dto.evidenceReference,
        },
      });
      return updated;
    });
  }

  async reviewRelease(
    actor: AuthenticatedUser,
    id: string,
    dto: ReviewLegalHoldReleaseDto,
  ) {
    this.assertPlatformAdmin(actor);
    const hold = await this.prisma.legalHold.findUnique({ where: { id } });
    if (!hold) throw new NotFoundException('Legal hold not found.');

    return this.withOrganizationLock(hold.organizationId, async (tx) => {
      const current = await tx.legalHold.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Legal hold not found.');
      if (current.status !== LegalHoldStatus.RELEASE_PENDING) {
        throw new ConflictException('Release must be requested before review.');
      }
      if (actor.id === current.releaseRequestedById) {
        throw new ForbiddenException('The release approver must be independent from the requester.');
      }
      await this.assertAuthorizedPlatformUser(tx, actor.id);
      const releaseApprovedAt = new Date();
      const updated = await tx.legalHold.update({
        where: { id },
        data: {
          releaseApprovedById: actor.id,
          releaseApprovedAt,
          releaseAuthorityReference: dto.authorityReference,
        },
      });
      await tx.legalHoldEvent.create({
        data: {
          legalHoldId: id,
          organizationIdHash: this.hashOrganizationId(current.organizationId),
          caseReference: current.caseReference,
          action: 'RELEASE_APPROVED',
          actorUserId: actor.id,
          authorityReference: dto.authorityReference,
          evidenceReference: dto.evidenceReference,
        },
      });
      return updated;
    });
  }

  private async withOrganizationLock<T>(
    organizationId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockOrganization(tx, organizationId);
      return work(tx);
    });
  }

  private async lockOrganization(tx: Prisma.TransactionClient, organizationId: string) {
    await tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${organizationId}, 0))`;
  }

  private async assertDeletionAllowed(
    tx: Prisma.TransactionClient,
    input: DeletionGuardInput,
  ) {
    const holds = await tx.legalHold.findMany({
      where: {
        organizationId: input.organizationId,
        status: { in: BLOCKING_STATUSES },
        effectiveAt: { lte: new Date() },
      },
      include: { documents: { select: { documentId: true } } },
    });
    if (holds.length === 0) return;

    const organizationHold = holds.find((hold) => hold.scopeType === 'ORGANIZATION');
    if (organizationHold) throw new LegalHoldBlockedError(organizationHold);

    const documentHolds = holds.filter((hold) => hold.scopeType === 'DOCUMENT');
    if (input.organizationWide || input.allDocuments) {
      throw new LegalHoldBlockedError(documentHolds[0]);
    }
    const heldDocumentIds = new Set(
      documentHolds.flatMap((hold) => hold.documents.map((item) => item.documentId)),
    );
    const directDocument = input.documentIds?.find((id) => heldDocumentIds.has(id));
    if (directDocument) throw new LegalHoldBlockedError(this.holdForDocument(documentHolds, directDocument));

    const heldIds = [...heldDocumentIds];
    if (heldIds.length === 0) return;
    if (input.allActivities || input.activityIds?.length) {
      const activity = await tx.activityData.findFirst({
        where: {
          organizationId: input.organizationId,
          ...(input.allActivities ? {} : { id: { in: input.activityIds } }),
          OR: [
            { documentId: { in: heldIds } },
            { sourceDocumentId: { in: heldIds } },
          ],
        },
        select: { documentId: true, sourceDocumentId: true },
      });
      const heldId = activity?.documentId ?? activity?.sourceDocumentId;
      if (heldId && heldDocumentIds.has(heldId)) {
        throw new LegalHoldBlockedError(this.holdForDocument(documentHolds, heldId));
      }
    }
    if (input.allReports || input.reportIds?.length) {
      const report = await tx.report.findFirst({
        where: {
          organizationId: input.organizationId,
          ...(input.allReports ? {} : { id: { in: input.reportIds } }),
          documents: { some: { id: { in: heldIds } } },
        },
        select: { documents: { where: { id: { in: heldIds } }, select: { id: true }, take: 1 } },
      });
      const heldId = report?.documents[0]?.id;
      if (heldId) throw new LegalHoldBlockedError(this.holdForDocument(documentHolds, heldId));
    }
    if (input.factorIds?.length) {
      const metric = await tx.metricResult.findFirst({
        where: {
          organizationId: input.organizationId,
          factorId: { in: input.factorIds },
          activityData: {
            is: {
              organizationId: input.organizationId,
              OR: [
                { documentId: { in: heldIds } },
                { sourceDocumentId: { in: heldIds } },
              ],
            },
          },
        },
        select: { activityData: { select: { documentId: true, sourceDocumentId: true } } },
      });
      const heldId = metric?.activityData?.documentId ?? metric?.activityData?.sourceDocumentId;
      if (heldId) throw new LegalHoldBlockedError(this.holdForDocument(documentHolds, heldId));
    }
  }

  private holdForDocument<THold extends { documents: { documentId: string }[] }>(
    holds: THold[],
    documentId: string,
  ) {
    return holds.find((hold) => hold.documents.some((item) => item.documentId === documentId))!;
  }

  private async assertActiveUser(
    tx: Prisma.TransactionClient,
    userId: string,
    label: string,
  ) {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { isActive: true } });
    if (!user?.isActive) throw new BadRequestException(`${label} must be an active user.`);
  }

  private async assertAuthorizedPlatformUser(
    tx: Prisma.TransactionClient,
    approverId: string,
  ) {
    const approver = await tx.user.findUnique({
      where: { id: approverId },
      select: { role: true, isActive: true, accountType: true },
    });
    if (
      !approver?.isActive ||
      approver.role !== UserRole.ADMIN ||
      approver.accountType === 'PILOT_REVIEWER'
    ) {
      throw new ForbiddenException('A separate authorized platform approver is required.');
    }
  }

  private assertPlatformAdmin(actor: AuthenticatedUser) {
    if (!isPlatformAdmin(actor)) {
      throw new ForbiddenException('Only a platform administrator can administer legal holds.');
    }
  }

  private async recordBlockedAttempt(
    error: LegalHoldBlockedError,
    input: DeletionGuardInput,
  ) {
    await this.prisma.legalHoldEvent.create({
      data: {
        legalHoldId: error.hold.id,
        organizationIdHash: this.hashOrganizationId(input.organizationId),
        caseReference: error.hold.caseReference,
        action: 'BLOCKED_DELETION',
        actorUserId: input.actorUserId ?? 'SYSTEM',
        authorityReference: error.hold.authorityReference,
        evidenceReference: error.hold.evidenceReference,
        operation: input.operation,
        targetCount: this.targetCount(input),
      },
    });
  }

  private targetCount(input: DeletionGuardInput) {
    if (input.organizationWide || input.allDocuments || input.allActivities || input.allReports) return null;
    return new Set([
      ...(input.documentIds ?? []),
      ...(input.activityIds ?? []),
      ...(input.reportIds ?? []),
      ...(input.factorIds ?? []),
    ]).size;
  }

  private hashOrganizationId(organizationId: string) {
    return createHash('sha256').update(organizationId).digest('hex');
  }
}

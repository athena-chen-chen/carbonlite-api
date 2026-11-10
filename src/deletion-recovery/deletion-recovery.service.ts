import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DocumentDeletionIntentStatus,
  DocumentDeletionTargetType,
  LegalHoldStatus,
  Prisma,
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../auth/auth.service';
import { isPlatformAdmin } from '../common/permissions/workspace-permissions';
import {
  DOCUMENT_STORAGE,
  DocumentStorage,
  documentQuarantineKey,
  documentStorageKey,
  isVirtualSpreadsheetSourceUrl,
} from '../documents/document-storage';
import { LegalHoldsService } from '../legal-holds/legal-holds.service';
import { PrismaService } from '../prisma/prisma.service';

export type DeletionStorageItem = {
  storageKey: string;
  documentId?: string;
  targetReferenceId?: string;
  targetType: DocumentDeletionTargetType;
};

const REVIEW_WINDOW_MS = 15 * 60 * 1000;
const OVERDUE_REVIEW_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class DeletionRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    private readonly legalHolds: LegalHoldsService,
  ) {}

  async deleteVirtualDocument(
    organizationId: string,
    documentId: string,
    requestedById?: string,
  ) {
    return this.legalHolds.withDeletionGuard(
      {
        organizationId,
        operation: 'DELETE_DOCUMENT',
        actorUserId: requestedById,
        documentIds: [documentId],
      },
      async (tx) => {
        const document = await tx.document.findUnique({
          where: { id: documentId },
          select: { id: true, organizationId: true, fileUrl: true },
        });
        if (!document) return null;
        if (document.organizationId !== organizationId) {
          throw new ForbiddenException('You cannot delete this document.');
        }
        if (!isVirtualSpreadsheetSourceUrl(document.fileUrl)) {
          throw new BadRequestException(
            'Document is not a virtual spreadsheet source.',
          );
        }

        const preservedActivityRecords = await tx.activityData.count({
          where: {
            organizationId,
            OR: [{ documentId }, { sourceDocumentId: documentId }],
          },
        });
        await tx.document.delete({ where: { id: documentId } });
        await tx.auditLog.create({
          data: {
            organizationId,
            userId: requestedById ?? null,
            action: 'DELETE_DOCUMENT',
            entityType: 'Document',
            entityId: documentId,
            description:
              'Virtual spreadsheet source metadata deleted; imported activity records preserved.',
            newValue: {
              documentId,
              preservedActivityRecords,
              sourceEvidence: 'NONE',
            },
          },
        });
        await tx.userActivityEvent.create({
          data: {
            organizationId,
            userId: requestedById ?? null,
            eventName: 'DOCUMENT_DELETED',
            entityType: 'Document',
            entityId: documentId,
            metadata: { preservedActivityRecords, sourceEvidence: 'NONE' },
          },
        });
        return { preservedActivityRecords };
      },
    );
  }

  async prepareDocument(
    organizationId: string,
    documentId: string,
    requestedById?: string,
  ) {
    return this.legalHolds.withDeletionGuard({
      organizationId,
      operation: 'PREPARE_DOCUMENT_DELETION',
      actorUserId: requestedById,
      documentIds: [documentId],
    }, async (tx) => {
      const document = await tx.document.findUnique({
        where: { id: documentId },
        select: { id: true, organizationId: true, fileUrl: true },
      });
      if (!document) {
        return tx.documentDeletionIntent.findFirst({
          where: { organizationId, documentId },
          orderBy: { createdAt: 'desc' },
        });
      }
      if (document.organizationId !== organizationId) {
        throw new ForbiddenException('You cannot delete this document.');
      }
      const storageKey = documentStorageKey(document.fileUrl);
      const existing = await tx.documentDeletionIntent.findUnique({
        where: { organizationId_storageKey: { organizationId, storageKey } },
      });
      if (existing) return existing;
      const id = this.newIntentId();
      return tx.documentDeletionIntent.create({
        data: {
          id,
          organizationId,
          organizationIdHash: this.hash(organizationId),
          documentId,
          targetReferenceId: documentId,
          targetType: DocumentDeletionTargetType.DOCUMENT,
          storageKey,
          quarantineKey: documentQuarantineKey(id, storageKey),
          operation: 'DELETE_DOCUMENT',
          requestedById,
        },
      });
    });
  }

  async completeDocument(
    organizationId: string,
    documentId: string,
    requestedById?: string,
  ) {
    const outcome = await this.legalHolds.withDeletionGuard({
      organizationId,
      operation: 'DELETE_DOCUMENT',
      actorUserId: requestedById,
      documentIds: [documentId],
    }, async (tx) => {
      const intent = await tx.documentDeletionIntent.findFirst({
        where: { organizationId, documentId },
        orderBy: { createdAt: 'desc' },
      });
      if (!intent) return { kind: 'NOT_FOUND' as const };
      if (intent.status === DocumentDeletionIntentStatus.PENDING_PURGE ||
          intent.status === DocumentDeletionIntentStatus.PURGED) {
        return { kind: 'COMPLETE' as const, intent, idempotent: true, preservedActivityRecords: 0 };
      }
      if (intent.status === DocumentDeletionIntentStatus.RECONCILIATION_REQUIRED) {
        return { kind: 'RECONCILIATION_REQUIRED' as const };
      }
      const document = await tx.document.findUnique({ where: { id: documentId } });
      if (!document || document.organizationId !== organizationId) {
        await tx.documentDeletionIntent.update({
          where: { id: intent.id },
          data: { status: DocumentDeletionIntentStatus.RECONCILIATION_REQUIRED, reconciliationCode: 'DOCUMENT_ROW_MISSING' },
        });
        return { kind: 'RECONCILIATION_REQUIRED' as const };
      }

      const movement = await this.storage.quarantine(intent.storageKey, intent.id);
      if (movement.quarantineKey !== intent.quarantineKey || movement.result === 'NOT_FOUND') {
        await tx.documentDeletionIntent.update({
          where: { id: intent.id },
          data: { status: DocumentDeletionIntentStatus.RECONCILIATION_REQUIRED, reconciliationCode: 'ACTIVE_AND_QUARANTINE_MISSING' },
        });
        return { kind: 'RECONCILIATION_REQUIRED' as const };
      }

      const preservedActivityRecords = await tx.activityData.count({
        where: {
          organizationId,
          OR: [{ documentId }, { sourceDocumentId: documentId }],
        },
      });
      await tx.document.delete({ where: { id: documentId } });
      const completed = await tx.documentDeletionIntent.update({
        where: { id: intent.id },
        data: {
          status: DocumentDeletionIntentStatus.PENDING_PURGE,
          databaseDeletedAt: new Date(),
          reconciliationCode: null,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId,
          userId: requestedById ?? null,
          action: 'DELETE_DOCUMENT',
          entityType: 'DocumentDeletionIntent',
          entityId: completed.id,
          description: 'Source document moved to recoverable quarantine and database metadata deleted.',
          newValue: { documentId, deletionIntentId: completed.id, preservedActivityRecords },
        },
      });
      await tx.userActivityEvent.create({
        data: {
          organizationId,
          userId: requestedById ?? null,
          eventName: 'DOCUMENT_DELETED',
          entityType: 'Document',
          entityId: documentId,
          metadata: { deletionIntentId: completed.id, preservedActivityRecords, sourceEvidence: 'QUARANTINED' },
        },
      });
      return { kind: 'COMPLETE' as const, intent: completed, idempotent: false, preservedActivityRecords };
    });

    if (outcome.kind === 'NOT_FOUND') return null;
    if (outcome.kind === 'RECONCILIATION_REQUIRED') {
      throw new ServiceUnavailableException(
        'Document deletion requires storage reconciliation; no permanent purge was attempted.',
      );
    }
    return outcome;
  }

  async prepareReport(
    organizationId: string,
    reportId: string,
  ) {
    return this.legalHolds.withDeletionGuard({
      organizationId,
      operation: 'PREPARE_REPORT_DELETION',
      reportIds: [reportId],
    }, async (tx) => {
      const existing = await tx.documentDeletionIntent.findFirst({
        where: { organizationId, targetReferenceId: reportId, operation: 'DELETE_REPORT' },
      });
      if (existing) return { found: true as const, intent: existing };
      const report = await tx.report.findFirst({
        where: { id: reportId, organizationId },
        select: { id: true, generatedPdfUrl: true },
      });
      if (!report) return { found: false as const, intent: null };
      if (!report.generatedPdfUrl) return { found: true as const, intent: null };
      if (!report.generatedPdfUrl.startsWith('/uploads/')) {
        throw new ConflictException('Report artifact is outside managed storage; deletion cannot safely continue.');
      }
      const storageKey = documentStorageKey(report.generatedPdfUrl);
      const id = this.newIntentId();
      const intent = await tx.documentDeletionIntent.create({
        data: {
          id,
          organizationId,
          organizationIdHash: this.hash(organizationId),
          targetReferenceId: reportId,
          targetType: DocumentDeletionTargetType.REPORT_ARTIFACT,
          storageKey,
          quarantineKey: documentQuarantineKey(id, storageKey),
          operation: 'DELETE_REPORT',
        },
      });
      return { found: true as const, intent };
    });
  }

  async completeReport(organizationId: string, reportId: string) {
    const outcome = await this.legalHolds.withDeletionGuard({
      organizationId,
      operation: 'DELETE_REPORT',
      reportIds: [reportId],
    }, async (tx) => {
      const intent = await tx.documentDeletionIntent.findFirst({
        where: { organizationId, targetReferenceId: reportId, operation: 'DELETE_REPORT' },
      });
      if (intent?.status === DocumentDeletionIntentStatus.PENDING_PURGE ||
          intent?.status === DocumentDeletionIntentStatus.PURGED) {
        return { kind: 'COMPLETE' as const, intent, idempotent: true };
      }
      if (intent?.status === DocumentDeletionIntentStatus.RECONCILIATION_REQUIRED) {
        return { kind: 'RECONCILIATION_REQUIRED' as const };
      }
      const report = await tx.report.findFirst({
        where: { id: reportId, organizationId },
        select: { id: true, generatedPdfUrl: true },
      });
      if (!report) return { kind: 'NOT_FOUND' as const };
      if (report.generatedPdfUrl && !intent) {
        return { kind: 'RECONCILIATION_REQUIRED' as const };
      }
      if (intent) {
        if (!(await this.quarantinePreparedIntent(tx, intent))) {
          return { kind: 'RECONCILIATION_REQUIRED' as const };
        }
      }
      await tx.report.delete({ where: { id: reportId } });
      const completed = intent ? await tx.documentDeletionIntent.update({
        where: { id: intent.id },
        data: { status: DocumentDeletionIntentStatus.PENDING_PURGE, databaseDeletedAt: new Date() },
      }) : null;
      return { kind: 'COMPLETE' as const, intent: completed, idempotent: false };
    });
    if (outcome.kind === 'RECONCILIATION_REQUIRED') {
      throw new ServiceUnavailableException('Report deletion requires storage reconciliation.');
    }
    return outcome.kind === 'NOT_FOUND' ? null : outcome;
  }

  async prepareWorkspace(
    organizationId: string,
    items: DeletionStorageItem[],
    requestedById: string,
  ) {
    return this.legalHolds.withDeletionGuard({
      organizationId,
      operation: 'PREPARE_WORKSPACE_ERASURE',
      actorUserId: requestedById,
      organizationWide: true,
    }, (tx) => this.prepareWorkspaceInTransaction(tx, organizationId, items, requestedById));
  }

  async prepareWorkspaceInTransaction(
    tx: Prisma.TransactionClient,
    organizationId: string,
    items: DeletionStorageItem[],
    requestedById: string,
  ) {
      const intents = [];
      for (const item of items) {
        const existing = await tx.documentDeletionIntent.findUnique({
          where: { organizationId_storageKey: { organizationId, storageKey: item.storageKey } },
        });
        if (existing) {
          intents.push(existing.status === DocumentDeletionIntentStatus.PREPARED && existing.operation !== 'ERASE_WORKSPACE'
            ? await tx.documentDeletionIntent.update({
                where: { id: existing.id },
                data: {
                  operation: 'ERASE_WORKSPACE',
                  requestedById,
                  targetReferenceId: item.targetReferenceId ?? item.documentId ?? existing.targetReferenceId,
                },
              })
            : existing);
          continue;
        }
        const id = this.newIntentId();
        intents.push(await tx.documentDeletionIntent.create({
          data: {
            id,
            organizationId,
            organizationIdHash: this.hash(organizationId),
            documentId: item.documentId,
            targetReferenceId: item.targetReferenceId ?? item.documentId ?? id,
            targetType: item.targetType,
            storageKey: item.storageKey,
            quarantineKey: documentQuarantineKey(id, item.storageKey),
            operation: 'ERASE_WORKSPACE',
            requestedById,
          },
        }));
      }
      return intents;
  }

  async quarantinePreparedIntent(
    tx: Prisma.TransactionClient,
    intent: { id: string; storageKey: string; quarantineKey: string },
  ) {
    const movement = await this.storage.quarantine(intent.storageKey, intent.id);
    if (movement.result === 'NOT_FOUND' || movement.quarantineKey !== intent.quarantineKey) {
      await tx.documentDeletionIntent.update({
        where: { id: intent.id },
        data: { status: DocumentDeletionIntentStatus.RECONCILIATION_REQUIRED, reconciliationCode: 'ACTIVE_AND_QUARANTINE_MISSING' },
      });
      return false;
    }
    return true;
  }

  async reconcile(actor: AuthenticatedUser, organizationId?: string) {
    this.assertPlatformAdmin(actor);
    const [documents, reports, intents, activeEntries, quarantineEntries] = await Promise.all([
      this.prisma.document.findMany({
        where: organizationId ? { organizationId } : undefined,
        select: { id: true, organizationId: true, fileUrl: true, updatedAt: true },
      }),
      this.prisma.report.findMany({
        where: {
          ...(organizationId ? { organizationId } : {}),
          generatedPdfUrl: { startsWith: '/uploads/' },
        },
        select: { generatedPdfUrl: true },
      }),
      this.prisma.documentDeletionIntent.findMany({
        where: organizationId ? { organizationId } : undefined,
        orderBy: { preparedAt: 'asc' },
      }),
      this.storage.listActive(),
      this.storage.listQuarantine(),
    ]);
    const active = new Map(activeEntries.map((entry) => [entry.storageKey, entry]));
    const quarantine = new Map(quarantineEntries.map((entry) => [entry.storageKey, entry]));
    const expectedActiveKeys = new Set([
      ...documents.map(({ fileUrl }) => documentStorageKey(fileUrl)),
      ...reports.flatMap(({ generatedPdfUrl }) => generatedPdfUrl ? [documentStorageKey(generatedPdfUrl)] : []),
    ]);
    const intentQuarantineKeys = new Set(intents.map(({ quarantineKey }) => quarantineKey));
    const threshold = new Date(Date.now() - OVERDUE_REVIEW_MS);
    const blockingStatuses = [LegalHoldStatus.PROVISIONAL, LegalHoldStatus.ACTIVE, LegalHoldStatus.RELEASE_PENDING];
    const heldOrganizations = new Set(await this.heldOrganizationIds(blockingStatuses));
    const documentHoldMappings = await this.prisma.legalHoldDocument.findMany({
      where: {
        documentId: { in: intents.flatMap(({ documentId }) => documentId ? [documentId] : []) },
        legalHold: { status: { in: blockingStatuses }, effectiveAt: { lte: new Date() } },
      },
      select: { documentId: true },
    });
    const heldDocuments = new Set(documentHoldMappings.map(({ documentId }) => documentId));

    return {
      generatedAt: new Date().toISOString(),
      mutated: false,
      databaseReferencesMissingBytes: documents
        .filter(({ fileUrl }) => !active.has(documentStorageKey(fileUrl)))
        .map(({ id, organizationId: org }) => ({ documentId: id, organizationIdHash: this.hash(org) })),
      reportReferencesMissingBytes: reports
        .filter(({ generatedPdfUrl }) => Boolean(generatedPdfUrl && !active.has(documentStorageKey(generatedPdfUrl))))
        .map(({ generatedPdfUrl }) => ({ storageKeyHash: this.hash(documentStorageKey(generatedPdfUrl!)) })),
      activeFilesWithoutDatabaseReferences: activeEntries
        .filter(({ storageKey }) => !expectedActiveKeys.has(storageKey))
        .map((entry) => ({ storageKeyHash: this.hash(entry.storageKey), modifiedAt: entry.modifiedAt })),
      quarantineEntriesWithoutIntent: quarantineEntries
        .filter(({ storageKey }) => !intentQuarantineKeys.has(storageKey))
        .map((entry) => ({ storageKeyHash: this.hash(entry.storageKey), modifiedAt: entry.modifiedAt })),
      overduePendingDeletions: intents
        .filter(({ status, preparedAt }) => status === DocumentDeletionIntentStatus.PENDING_PURGE && preparedAt < threshold)
        .map(({ id, organizationId: org }) => ({ deletionIntentId: id, organizationIdHash: this.hash(org) })),
      holdProtectedPendingDeletions: intents
        .filter((intent) => intent.status === DocumentDeletionIntentStatus.PENDING_PURGE && (
          heldOrganizations.has(intent.organizationId) || Boolean(intent.documentId && heldDocuments.has(intent.documentId))
        ))
        .map(({ id }) => ({ deletionIntentId: id })),
      restoreMismatches: intents
        .filter((intent) =>
          (intent.status === DocumentDeletionIntentStatus.PENDING_PURGE && active.has(intent.storageKey)) ||
          (intent.status === DocumentDeletionIntentStatus.PENDING_PURGE && !quarantine.has(intent.quarantineKey)) ||
          (intent.status === DocumentDeletionIntentStatus.PURGED && (active.has(intent.storageKey) || quarantine.has(intent.quarantineKey))))
        .map((intent) => ({
          deletionIntentId: intent.id,
          reason: intent.status === DocumentDeletionIntentStatus.PENDING_PURGE && !quarantine.has(intent.quarantineKey)
            ? 'PENDING_RECOVERY_BYTES_MISSING'
            : 'STORAGE_STATE_NEWER_THAN_DELETION_REGISTER',
        })),
      reconciliationRequired: intents
        .filter(({ status }) => status === DocumentDeletionIntentStatus.RECONCILIATION_REQUIRED)
        .map(({ id, reconciliationCode }) => ({ deletionIntentId: id, reconciliationCode })),
    };
  }

  async purgeDryRun(actor: AuthenticatedUser, candidateIds: string[]) {
    this.assertPlatformAdmin(actor);
    const ids = this.exactIds(candidateIds);
    const intents = await this.loadPurgeCandidates(ids);
    const organizationId = this.oneOrganization(intents);
    await this.assertNoUnresolvedRecoveryCases(organizationId);
    await this.legalHolds.withDeletionGuard({
      organizationId,
      operation: 'REVIEW_DOCUMENT_PURGE',
      actorUserId: actor.id,
      organizationWide: intents.some(({ targetType }) => targetType !== DocumentDeletionTargetType.DOCUMENT),
      documentIds: intents.flatMap(({ documentId }) => documentId ? [documentId] : []),
    }, async () => undefined);
    for (const intent of intents) await this.assertPurgeStorageConsistent(intent);
    const token = randomUUID();
    const digest = this.candidateDigest(ids);
    const review = await this.prisma.documentDeletionPurgeReview.create({
      data: {
        organizationIdHash: this.hash(organizationId),
        candidateIds: ids,
        candidateDigest: digest,
        tokenHash: this.hash(token),
        reviewedById: actor.id,
        expiresAt: new Date(Date.now() + REVIEW_WINDOW_MS),
      },
    });
    return {
      status: 'DRY_RUN',
      reviewId: review.id,
      reviewToken: token,
      expiresAt: review.expiresAt,
      candidateIds: ids,
      filesToPurge: intents.length,
      dataDeleted: false,
    };
  }

  async purge(actor: AuthenticatedUser, candidateIds: string[], token: string, confirmed: boolean) {
    this.assertPlatformAdmin(actor);
    if (!confirmed) throw new BadRequestException('Explicit purge confirmation is required.');
    const ids = this.exactIds(candidateIds);
    const review = await this.prisma.documentDeletionPurgeReview.findUnique({
      where: { tokenHash: this.hash(token) },
    });
    if (!review || review.consumedAt || review.expiresAt <= new Date() ||
        review.candidateDigest !== this.candidateDigest(ids)) {
      throw new ConflictException('A current dry-run for the exact candidate IDs is required.');
    }
    const reviewedIds = review.candidateIds as string[];
    if (reviewedIds.length !== ids.length || reviewedIds.some((id, index) => id !== ids[index])) {
      throw new ConflictException('Purge candidates do not match the reviewed dry-run.');
    }
    const intents = await this.loadPurgeCandidates(ids);
    const organizationId = this.oneOrganization(intents);
    return this.legalHolds.withDeletionGuard({
      organizationId,
      operation: 'PURGE_QUARANTINED_DOCUMENTS',
      actorUserId: actor.id,
      organizationWide: intents.some(({ targetType }) => targetType !== DocumentDeletionTargetType.DOCUMENT),
      documentIds: intents.flatMap(({ documentId }) => documentId ? [documentId] : []),
    }, async (tx) => {
      const unresolved = await tx.documentDeletionIntent.count({
        where: {
          organizationId,
          status: { in: [
            DocumentDeletionIntentStatus.PREPARED,
            DocumentDeletionIntentStatus.RECONCILIATION_REQUIRED,
          ] },
        },
      });
      if (unresolved > 0) {
        throw new ConflictException('Unresolved deletion recovery cases must be reconciled before purge.');
      }
      for (const intent of intents) {
        await this.assertPurgeStorageConsistent(intent);
        const result = await this.storage.purgeQuarantine(intent.quarantineKey);
        if (result !== 'DELETED') {
          throw new ServiceUnavailableException('Quarantine purge failed closed; manual reconciliation is required.');
        }
        await tx.documentDeletionIntent.update({
          where: { id: intent.id },
          data: { status: DocumentDeletionIntentStatus.PURGED, purgedAt: new Date() },
        });
      }
      await tx.documentDeletionPurgeReview.update({
        where: { id: review.id },
        data: { consumedById: actor.id, consumedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          organizationId: null,
          userId: actor.id,
          action: 'DOCUMENT_QUARANTINE_PURGED',
          entityType: 'DocumentDeletionPurgeReview',
          entityId: review.id,
          description: 'Purged an explicitly reviewed set of quarantined files.',
          newValue: { candidateCount: ids.length, candidateDigest: review.candidateDigest },
        },
      });
      return { status: 'PURGED', candidateIds: ids, purgedFiles: ids.length };
    });
  }

  private async loadPurgeCandidates(ids: string[]) {
    const intents = await this.prisma.documentDeletionIntent.findMany({ where: { id: { in: ids } } });
    if (intents.length !== ids.length || intents.some(({ status }) => status !== DocumentDeletionIntentStatus.PENDING_PURGE)) {
      throw new ConflictException('Every purge candidate must be a pending, recoverable deletion.');
    }
    return ids.map((id) => intents.find((intent) => intent.id === id)!);
  }

  private async assertPurgeStorageConsistent(intent: { storageKey: string; quarantineKey: string }) {
    const [active, quarantined] = await Promise.all([
      this.storage.exists(intent.storageKey),
      this.storage.quarantineExists(intent.quarantineKey),
    ]);
    if (active || !quarantined) {
      throw new ConflictException('Purge candidate storage is inconsistent; reconciliation is required.');
    }
  }

  private async assertNoUnresolvedRecoveryCases(organizationId: string) {
    const unresolved = await this.prisma.documentDeletionIntent.count({
      where: {
        organizationId,
        status: { in: [
          DocumentDeletionIntentStatus.PREPARED,
          DocumentDeletionIntentStatus.RECONCILIATION_REQUIRED,
        ] },
      },
    });
    if (unresolved > 0) {
      throw new ConflictException('Unresolved deletion recovery cases must be reconciled before purge.');
    }
  }

  private async heldOrganizationIds(statuses: LegalHoldStatus[]) {
    const holds = await this.prisma.legalHold.findMany({
      where: { scopeType: 'ORGANIZATION', status: { in: statuses }, effectiveAt: { lte: new Date() } },
      select: { organizationId: true },
    });
    return holds.map(({ organizationId }) => organizationId);
  }

  private oneOrganization(intents: { organizationId: string }[]) {
    const organizations = new Set(intents.map(({ organizationId }) => organizationId));
    if (organizations.size !== 1) throw new BadRequestException('Purge candidates must belong to one organization.');
    return intents[0].organizationId;
  }

  private exactIds(candidateIds: string[]) {
    const ids = [...new Set(candidateIds)].sort();
    if (!ids.length || ids.length !== candidateIds.length) {
      throw new BadRequestException('Exact, unique candidate IDs are required.');
    }
    return ids;
  }

  private candidateDigest(ids: string[]) {
    return this.hash(ids.join('\n'));
  }

  private assertPlatformAdmin(actor: AuthenticatedUser) {
    if (!isPlatformAdmin(actor)) throw new ForbiddenException('Only a platform administrator can reconcile or purge storage.');
  }

  private newIntentId() {
    return `ddi_${randomUUID().replaceAll('-', '')}`;
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}

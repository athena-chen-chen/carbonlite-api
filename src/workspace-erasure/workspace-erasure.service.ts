import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthenticatedUser } from '../auth/auth.service';
import { isPlatformAdmin } from '../common/permissions/workspace-permissions';
import { PrismaService } from '../prisma/prisma.service';
import {
  DOCUMENT_STORAGE,
  DocumentStorage,
  documentStorageKey,
} from '../documents/document-storage';
import { EraseWorkspaceDto } from './dto/workspace-erasure.dto';
import { LegalHoldsService } from '../legal-holds/legal-holds.service';
import { DeletionRecoveryService, DeletionStorageItem } from '../deletion-recovery/deletion-recovery.service';
import { DocumentDeletionIntentStatus, DocumentDeletionTargetType } from '@prisma/client';

export type WorkspaceErasureInventory = {
  organizationId: string;
  organizationSlug: string;
  users: number;
  memberships: number;
  facilities: number;
  assets: number;
  documents: number;
  physicalFiles: number;
  documentExtractions: number;
  spreadsheetReviewRows: number;
  activityRecords: number;
  calculationSnapshots: number;
  importBatches: number;
  metricResults: number;
  reports: number;
  reportArtifacts: number;
  aiJobs: number;
  customConversionFactors: number;
  auditLogs: number;
  feedback: number;
  activityEvents: number;
  quotaPolicies: number;
  quotaPeriods: number;
  quotaUsages: number;
  aiAuthorizations: number;
};

type InventoryPlan = {
  inventory: WorkspaceErasureInventory;
  storageItems: DeletionStorageItem[];
  unsupportedReportArtifacts: string[];
};

@Injectable()
export class WorkspaceErasureService {
  private readonly logger = new Logger(WorkspaceErasureService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    @Optional() private readonly legalHolds?: LegalHoldsService,
    @Optional() private readonly deletionRecovery?: DeletionRecoveryService,
  ) {}

  async dryRun(actor: AuthenticatedUser, organizationId: string) {
    this.assertAuthorized(actor, organizationId);
    const plan = await this.buildInventory(organizationId);
    return { status: 'DRY_RUN' as const, inventory: plan.inventory, dataDeleted: false };
  }

  async erase(actor: AuthenticatedUser, command: EraseWorkspaceDto) {
    this.assertAuthorized(actor, command.organizationId);
    if (
      command.confirmErase !== true ||
      command.confirmationOrganizationId !== command.organizationId
    ) {
      throw new BadRequestException('Exact organization confirmation is required.');
    }

    const organizationIdHash = this.hashId(command.organizationId);
    const initiatedAt = new Date();
    let plan: InventoryPlan | undefined;
    let quarantinedPhysicalFiles = 0;
    try {
      await this.holdGuard.withDeletionGuard({
        organizationId: command.organizationId,
        operation: 'PREPARE_WORKSPACE_ERASURE',
        actorUserId: actor.id,
        organizationWide: true,
      }, async (tx) => {
        plan = await this.buildInventory(command.organizationId, tx);
        if (command.confirmationOrganizationSlug !== plan.inventory.organizationSlug) {
          throw new BadRequestException('Exact organization slug confirmation is required.');
        }
        if (plan.unsupportedReportArtifacts.length > 0) {
          throw new ConflictException(
            'Workspace has report artifacts outside managed document storage; erasure cannot safely continue.',
          );
        }
        await this.recovery.prepareWorkspaceInTransaction(
          tx, command.organizationId, plan.storageItems, actor.id,
        );
      });

      const outcome = await this.holdGuard.withDeletionGuard({
        organizationId: command.organizationId,
        operation: 'ERASE_WORKSPACE',
        actorUserId: actor.id,
        organizationWide: true,
      }, async (tx) => {
        plan = await this.buildInventory(command.organizationId, tx);
        if (command.confirmationOrganizationSlug !== plan.inventory.organizationSlug) {
          throw new BadRequestException('Exact organization slug confirmation is required.');
        }
        if (plan.unsupportedReportArtifacts.length > 0) {
          throw new ConflictException(
            'Workspace has report artifacts outside managed document storage; erasure cannot safely continue.',
          );
        }
        const intents = await this.recovery.prepareWorkspaceInTransaction(
          tx, command.organizationId, plan.storageItems, actor.id,
        );
        for (const intent of intents) {
          if (intent.status === DocumentDeletionIntentStatus.RECONCILIATION_REQUIRED) {
            return { recoveryRequired: true as const };
          }
          if (intent.status === DocumentDeletionIntentStatus.PURGED) continue;
          if (!(await this.recovery.quarantinePreparedIntent(tx, intent))) {
            return { recoveryRequired: true as const };
          }
          quarantinedPhysicalFiles += 1;
        }
        const completedAt = new Date();
        const organization = await tx.organization.findUnique({
          where: { id: command.organizationId },
          select: { id: true },
        });
        if (organization) await tx.organization.delete({ where: { id: command.organizationId } });
        await tx.documentDeletionIntent.updateMany({
          where: {
            organizationId: command.organizationId,
            operation: 'ERASE_WORKSPACE',
            status: DocumentDeletionIntentStatus.PREPARED,
          },
          data: { status: DocumentDeletionIntentStatus.PENDING_PURGE, databaseDeletedAt: completedAt },
        });
        await tx.auditLog.create({
          data: {
            organizationId: null,
            userId: actor.id,
            action: 'WORKSPACE_ERASURE_COMPLETED',
            entityType: 'OrganizationHash',
            entityId: organizationIdHash,
            description: 'Completed customer workspace data erasure.',
            newValue: {
              initiatedAt: initiatedAt.toISOString(),
              completedAt: completedAt.toISOString(),
              counts: this.auditCounts(plan!.inventory),
              quarantinedPhysicalFiles,
            },
          },
        });
        return {
          status: 'ERASED' as const,
          organizationIdHash,
          inventory: plan.inventory,
          quarantinedPhysicalFiles,
        };
      });
      if ('recoveryRequired' in outcome) {
        throw new ServiceUnavailableException(
          'Workspace erasure requires storage reconciliation; database data was retained.',
        );
      }
      return outcome;
    } catch (error) {
      if (error instanceof NotFoundException) {
        const erased = await this.findCompletedErasure(command.organizationId);
        if (erased) return { status: 'ALREADY_ERASED' as const, organizationIdHash };
        throw error;
      }
      if (error instanceof BadRequestException || error instanceof ConflictException) throw error;
      const action = quarantinedPhysicalFiles
        ? 'WORKSPACE_ERASURE_RECOVERY_REQUIRED'
        : 'WORKSPACE_ERASURE_STORAGE_FAILED';
      await this.writeOperationalAudit(actor.id, organizationIdHash, action, {
        initiatedAt: initiatedAt.toISOString(),
        failedAt: new Date().toISOString(),
        quarantinedPhysicalFiles,
      }).catch(() => undefined);
      this.logger.error(
        `Workspace erasure failed organizationIdHash=${organizationIdHash}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException(
        quarantinedPhysicalFiles
          ? 'Workspace erasure was interrupted after recoverable quarantine movement. Database data was retained for a safe retry.'
          : 'Workspace source evidence quarantine failed. Database data was retained for a safe retry.',
      );
    }
  }

  private assertAuthorized(actor: AuthenticatedUser, organizationId: string) {
    if (!isPlatformAdmin(actor)) {
      throw new ForbiddenException('Only a platform administrator can erase a workspace.');
    }
    if (actor.organizationId === organizationId) {
      throw new ForbiddenException('A platform administrator cannot erase their active workspace.');
    }
  }

  private async buildInventory(
    organizationId: string,
    db: PrismaService | import('@prisma/client').Prisma.TransactionClient = this.prisma,
  ): Promise<InventoryPlan> {
    const organization = await db.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, slug: true },
    });
    if (!organization) throw new NotFoundException('Organization not found.');

    const [
      users, memberships, facilities, assets, documents, documentExtractions,
      spreadsheetReviewRows, activityRecords, calculationSnapshots, activityImports,
      documentImports, metricResults, reports, reportArtifacts, aiJobs,
      customConversionFactors, auditLogs, feedback, activityEvents,
      quotaPolicies, quotaPeriods, quotaUsages, aiAuthorizations,
    ] = await Promise.all([
      db.user.count({ where: { organizationId } }),
      db.membership.count({
        where: { OR: [{ organizationId }, { user: { organizationId } }] },
      }),
      db.facility.count({ where: { organizationId } }),
      db.asset.count({ where: { facility: { organizationId } } }),
      db.document.findMany({ where: { organizationId }, select: { id: true, fileUrl: true } }),
      db.documentExtraction.count({ where: { organizationId } }),
      db.spreadsheetImportReviewRow.count({ where: { organizationId } }),
      db.activityData.count({ where: { organizationId } }),
      db.activityData.count({ where: { organizationId, calculationVersion: { gt: 0 } } }),
      db.activityData.findMany({ where: { organizationId, importBatchId: { not: null } }, select: { importBatchId: true }, distinct: ['importBatchId'] }),
      db.document.findMany({ where: { organizationId, importBatchId: { not: null } }, select: { importBatchId: true }, distinct: ['importBatchId'] }),
      db.metricResult.count({ where: { organizationId } }),
      db.report.count({ where: { organizationId } }),
      db.report.findMany({ where: { organizationId, generatedPdfUrl: { not: null } }, select: { id: true, generatedPdfUrl: true } }),
      db.aIJob.count({ where: { organizationId } }),
      db.conversionFactor.count({ where: { organizationId } }),
      db.auditLog.count({ where: { organizationId } }),
      db.feedback.count({ where: { organizationId } }),
      db.userActivityEvent.count({ where: { organizationId } }),
      db.organizationQuota.count({ where: { organizationId } }),
      db.organizationQuotaPeriod.count({ where: { organizationId } }),
      db.organizationQuotaUsage.count({ where: { organizationId } }),
      db.organizationAiAuthorization.count({ where: { organizationId } }),
    ]);

    const documentStorageItems = documents
      .filter(({ fileUrl }) => !fileUrl.includes('://'))
      .map(({ id, fileUrl }) => ({
        storageKey: documentStorageKey(fileUrl),
        documentId: id,
        targetType: DocumentDeletionTargetType.DOCUMENT,
      }));
    const managedReportArtifactItems = reportArtifacts
      .filter(({ generatedPdfUrl }) => Boolean(generatedPdfUrl?.startsWith('/uploads/')))
      .map(({ id, generatedPdfUrl }) => ({
        storageKey: documentStorageKey(generatedPdfUrl!),
        targetReferenceId: id,
        targetType: DocumentDeletionTargetType.REPORT_ARTIFACT,
      }));
    const unsupportedReportArtifacts = reportArtifacts
      .map(({ generatedPdfUrl }) => generatedPdfUrl)
      .filter((value): value is string => Boolean(value && !value.startsWith('/uploads/')));
    const importBatches = new Set([
      ...activityImports.map(({ importBatchId }) => importBatchId),
      ...documentImports.map(({ importBatchId }) => importBatchId),
    ].filter(Boolean)).size;
    const storageItems = [...new Map(
      [...documentStorageItems, ...managedReportArtifactItems].map((item) => [item.storageKey, item]),
    ).values()];

    return {
      inventory: {
        organizationId: organization.id,
        organizationSlug: organization.slug,
        users,
        memberships,
        facilities,
        assets,
        documents: documents.length,
        physicalFiles: storageItems.length,
        documentExtractions,
        spreadsheetReviewRows,
        activityRecords,
        calculationSnapshots,
        importBatches,
        metricResults,
        reports,
        reportArtifacts: reportArtifacts.length,
        aiJobs,
        customConversionFactors,
        auditLogs,
        feedback,
        activityEvents,
        quotaPolicies,
        quotaPeriods,
        quotaUsages,
        aiAuthorizations,
      },
      storageItems,
      unsupportedReportArtifacts,
    };
  }

  private async findCompletedErasure(organizationId: string) {
    return this.prisma.auditLog.findFirst({
      where: {
        organizationId: null,
        action: 'WORKSPACE_ERASURE_COMPLETED',
        entityType: 'OrganizationHash',
        entityId: this.hashId(organizationId),
      },
      select: { id: true },
    });
  }

  private writeOperationalAudit(
    actorId: string,
    organizationIdHash: string,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    return this.prisma.auditLog.create({
      data: {
        organizationId: null,
        userId: actorId,
        action,
        entityType: 'OrganizationHash',
        entityId: organizationIdHash,
        description: action.replaceAll('_', ' ').toLowerCase(),
        newValue: metadata as never,
      },
    });
  }

  private hashId(organizationId: string) {
    return createHash('sha256').update(organizationId).digest('hex');
  }

  private get holdGuard() {
    if (!this.legalHolds) {
      throw new ServiceUnavailableException('Legal hold enforcement is unavailable.');
    }
    return this.legalHolds;
  }

  private get recovery() {
    if (!this.deletionRecovery) {
      throw new ServiceUnavailableException('Recoverable deletion enforcement is unavailable.');
    }
    return this.deletionRecovery;
  }

  private auditCounts(inventory: WorkspaceErasureInventory) {
    const { organizationId: _organizationId, organizationSlug: _organizationSlug, ...counts } = inventory;
    return counts;
  }
}

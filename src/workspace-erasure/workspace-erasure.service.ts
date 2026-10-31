import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
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
};

type InventoryPlan = {
  inventory: WorkspaceErasureInventory;
  storageKeys: string[];
  unsupportedReportArtifacts: string[];
};

@Injectable()
export class WorkspaceErasureService {
  private readonly logger = new Logger(WorkspaceErasureService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
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

    let plan: InventoryPlan;
    try {
      plan = await this.buildInventory(command.organizationId);
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      const erased = await this.findCompletedErasure(command.organizationId);
      if (erased) {
        return { status: 'ALREADY_ERASED' as const, organizationIdHash: this.hashId(command.organizationId) };
      }
      throw error;
    }

    if (command.confirmationOrganizationSlug !== plan.inventory.organizationSlug) {
      throw new BadRequestException('Exact organization slug confirmation is required.');
    }
    if (plan.unsupportedReportArtifacts.length > 0) {
      throw new ConflictException(
        'Workspace has report artifacts outside managed document storage; erasure cannot safely continue.',
      );
    }

    const organizationIdHash = this.hashId(command.organizationId);
    const initiatedAt = new Date();
    await this.writeOperationalAudit(actor.id, organizationIdHash, 'WORKSPACE_ERASURE_INITIATED', {
      initiatedAt: initiatedAt.toISOString(),
      counts: this.auditCounts(plan.inventory),
    });

    let deletedPhysicalFiles = 0;
    let alreadyMissingPhysicalFiles = 0;
    try {
      for (const storageKey of plan.storageKeys) {
        const result = await this.storage.delete(storageKey);
        if (result === 'DELETED') deletedPhysicalFiles += 1;
        else alreadyMissingPhysicalFiles += 1;
      }
    } catch (error) {
      await this.writeOperationalAudit(actor.id, organizationIdHash, 'WORKSPACE_ERASURE_STORAGE_FAILED', {
        initiatedAt: initiatedAt.toISOString(),
        failedAt: new Date().toISOString(),
        deletedPhysicalFiles,
        alreadyMissingPhysicalFiles,
      }).catch((auditError) => this.logger.error(
        `Workspace erasure failure audit could not be written organizationIdHash=${organizationIdHash}`,
        auditError instanceof Error ? auditError.stack : undefined,
      ));
      this.logger.error(
        `Workspace erasure storage phase failed organizationIdHash=${organizationIdHash}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException(
        'Workspace source evidence deletion failed. Database data was retained for a safe retry.',
      );
    }

    try {
      const completedAt = new Date();
      await this.prisma.$transaction(async (tx) => {
        const organization = await tx.organization.findUnique({
          where: { id: command.organizationId },
          select: { id: true },
        });
        if (organization) await tx.organization.delete({ where: { id: command.organizationId } });
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
              counts: this.auditCounts(plan.inventory),
              deletedPhysicalFiles,
              alreadyMissingPhysicalFiles,
            },
          },
        });
      });
      return {
        status: 'ERASED' as const,
        organizationIdHash,
        inventory: plan.inventory,
        deletedPhysicalFiles,
        alreadyMissingPhysicalFiles,
      };
    } catch {
      await this.writeOperationalAudit(actor.id, organizationIdHash, 'WORKSPACE_ERASURE_DATABASE_FAILED', {
        initiatedAt: initiatedAt.toISOString(),
        failedAt: new Date().toISOString(),
        deletedPhysicalFiles,
        alreadyMissingPhysicalFiles,
      }).catch(() => undefined);
      throw new ServiceUnavailableException(
        'Workspace database erasure failed after source cleanup. Retry is safe.',
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

  private async buildInventory(organizationId: string): Promise<InventoryPlan> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, slug: true },
    });
    if (!organization) throw new NotFoundException('Organization not found.');

    const [
      users, memberships, facilities, assets, documents, documentExtractions,
      spreadsheetReviewRows, activityRecords, calculationSnapshots, activityImports,
      documentImports, metricResults, reports, reportArtifacts, aiJobs,
      customConversionFactors, auditLogs, feedback, activityEvents,
    ] = await Promise.all([
      this.prisma.user.count({ where: { organizationId } }),
      this.prisma.membership.count({
        where: { OR: [{ organizationId }, { user: { organizationId } }] },
      }),
      this.prisma.facility.count({ where: { organizationId } }),
      this.prisma.asset.count({ where: { facility: { organizationId } } }),
      this.prisma.document.findMany({ where: { organizationId }, select: { fileUrl: true } }),
      this.prisma.documentExtraction.count({ where: { organizationId } }),
      this.prisma.spreadsheetImportReviewRow.count({ where: { organizationId } }),
      this.prisma.activityData.count({ where: { organizationId } }),
      this.prisma.activityData.count({ where: { organizationId, calculationVersion: { gt: 0 } } }),
      this.prisma.activityData.findMany({ where: { organizationId, importBatchId: { not: null } }, select: { importBatchId: true }, distinct: ['importBatchId'] }),
      this.prisma.document.findMany({ where: { organizationId, importBatchId: { not: null } }, select: { importBatchId: true }, distinct: ['importBatchId'] }),
      this.prisma.metricResult.count({ where: { organizationId } }),
      this.prisma.report.count({ where: { organizationId } }),
      this.prisma.report.findMany({ where: { organizationId, generatedPdfUrl: { not: null } }, select: { generatedPdfUrl: true } }),
      this.prisma.aIJob.count({ where: { organizationId } }),
      this.prisma.conversionFactor.count({ where: { organizationId } }),
      this.prisma.auditLog.count({ where: { organizationId } }),
      this.prisma.feedback.count({ where: { organizationId } }),
      this.prisma.userActivityEvent.count({ where: { organizationId } }),
    ]);

    const documentStorageKeys = documents
      .map(({ fileUrl }) => fileUrl)
      .filter((fileUrl) => !fileUrl.includes('://'))
      .map(documentStorageKey);
    const managedReportArtifactKeys = reportArtifacts
      .map(({ generatedPdfUrl }) => generatedPdfUrl)
      .filter((value): value is string => Boolean(value?.startsWith('/uploads/')))
      .map(documentStorageKey);
    const unsupportedReportArtifacts = reportArtifacts
      .map(({ generatedPdfUrl }) => generatedPdfUrl)
      .filter((value): value is string => Boolean(value && !value.startsWith('/uploads/')));
    const importBatches = new Set([
      ...activityImports.map(({ importBatchId }) => importBatchId),
      ...documentImports.map(({ importBatchId }) => importBatchId),
    ].filter(Boolean)).size;

    return {
      inventory: {
        organizationId: organization.id,
        organizationSlug: organization.slug,
        users,
        memberships,
        facilities,
        assets,
        documents: documents.length,
        physicalFiles: documentStorageKeys.length,
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
      },
      storageKeys: [...new Set([...documentStorageKeys, ...managedReportArtifactKeys])],
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

  private auditCounts(inventory: WorkspaceErasureInventory) {
    const { organizationId: _organizationId, organizationSlug: _organizationSlug, ...counts } = inventory;
    return counts;
  }
}

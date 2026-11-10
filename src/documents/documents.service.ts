import { assertDocumentSize, hashDocumentFile, readBoundedDocumentFile, validateDocumentContent, validateDocumentType } from './document-resource-policy';
import { inspectSpreadsheetContainer } from '../document-extraction/spreadsheet-activity-rows';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { unlink } from 'fs/promises';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ActivityTrackingService, trackOptionalActivity } from '../activity-tracking/activity-tracking.service';
import {
  createDocumentStorageKey,
  DOCUMENT_STORAGE,
  DocumentStorage,
  DocumentStorageNotFoundError,
  documentStorageKey,
  isVirtualSpreadsheetSourceUrl,
  persistedDocumentStorageUrl,
} from './document-storage';
import { OrganizationQuotasService } from '../organization-quotas/organization-quotas.service';
import { DeletionRecoveryService } from '../deletion-recovery/deletion-recovery.service';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly activityTracking: ActivityTrackingService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    @Inject(OrganizationQuotasService)
    private readonly quotas: OrganizationQuotasService | undefined = undefined,
    @Optional() private readonly deletionRecovery?: DeletionRecoveryService,
  ) {}

  async upload(
    organizationId: string,
    userId: string,
    file: Express.Multer.File,
    type?: string,
    allowDuplicate = false,
  ) {
    let created;
    let savedStorageKey: string | undefined;
    try {
      assertDocumentSize(file.size);
      const extension = validateDocumentType(file.originalname, file.mimetype);
      const buffer = await readBoundedDocumentFile(file.path);
      validateDocumentContent(file.originalname, buffer);
      if (extension === '.xlsx' || extension === '.xls') inspectSpreadsheetContainer(buffer);
      const fileHash = await hashDocumentFile(file.path);
      const existingDocument = await this.prisma.document.findFirst({
        where: { organizationId, fileHash }, orderBy: { createdAt: 'asc' },
        select: { id: true, fileName: true, createdAt: true },
      });
      if (existingDocument && !allowDuplicate) throw new ConflictException({
        message: 'This file appears to have already been uploaded.', existingDocument,
      });
      savedStorageKey = createDocumentStorageKey(organizationId, file.originalname);
      await this.storage.save(savedStorageKey, buffer);
      created = await this.quotaEnforcement.withUploadTransaction(
        { organizationId, userId, fileSize: file.size },
        async (tx) => {
          const acceptedDocument = await tx.document.create({
            data: {
              organizationId,
              uploadedById: userId,
              fileName: file.originalname,
              fileUrl: persistedDocumentStorageUrl(savedStorageKey!),
              mimeType: file.mimetype,
              fileSize: file.size,
              fileHash,
              type: (type as any) ?? 'OTHER',
              status: 'UPLOADED',
            },
          });
          await this.auditLog.log({
            organizationId,
            userId,
            action: 'UPLOAD_DOCUMENT',
            entityType: 'Document',
            entityId: acceptedDocument.id,
            description: `Uploaded document ${acceptedDocument.fileName}`,
            newValue: acceptedDocument,
          }, tx);
          return {
            value: acceptedDocument,
            accepted: true,
            documentId: acceptedDocument.id,
            metadata: {
              source: 'DOCUMENT_UPLOAD',
              fileSize: file.size,
              mimeType: file.mimetype,
            },
          };
        },
      );
    } catch (error) {
      if (savedStorageKey && !created) {
        try {
          await this.storage.delete(savedStorageKey);
        } catch (cleanupError) {
          this.logger.error(
            `Upload compensation failed storageKey=${savedStorageKey}`,
            cleanupError instanceof Error ? cleanupError.stack : undefined,
          );
          throw new ServiceUnavailableException(
            'Document upload failed and source cleanup requires attention.',
          );
        }
      }
      throw error;
    } finally {
      await unlink(file.path).catch(() => this.logger.warn('Temporary upload cleanup failed.'));
    }

    await trackOptionalActivity(this.activityTracking, {
      organizationId,
      userId,
      eventName: 'DOCUMENT_UPLOADED',
      entityType: 'Document',
      entityId: created.id,
      metadata: {
        sourceFileName: created.fileName,
        sourceDocumentId: created.id,
        fileType: created.type,
        mimeType: created.mimeType,
        fileSize: created.fileSize,
      },
    });

    return created;
  }

  async findAll(organizationId: string, query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const skip = (page - 1) * pageSize;

    const where = {
      organizationId,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.document.findMany({
        where,
        include: {
          extractions: {
            orderBy: { extractedAt: 'desc' },
            take: 1,
            select: {
              sourceRowCount: true,
              extractedRowCount: true,
            },
          },
          _count: {
            select: {
              activityData: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.document.count({ where }),
    ]);
    const quotaStatus = await this.quotaEnforcement.getStatus(organizationId);

    return {
      items: items.map((item) => {
        const latestExtraction = item.extractions[0];
        const { extractions, _count, ...document } = item;

        return {
          ...document,
          sourceRowCount: latestExtraction?.sourceRowCount ?? null,
          extractedRowCount: latestExtraction?.extractedRowCount ?? null,
          importedRecordCount: _count.activityData,
        };
      }),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      ...(quotaStatus?.enabled ? { quotaStatus } : {}),
    };
  }

  async getDownloadFile(
    organizationId: string,
    id: string,
    userId?: string,
    userAgent?: string,
  ) {
    const document = await this.prisma.document.findUnique({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        fileName: true,
        fileUrl: true,
        mimeType: true,
      },
    });

    if (!document) {
      throw new NotFoundException(`Document ${id} not found.`);
    }

    if (document.organizationId !== organizationId) {
      throw new ForbiddenException('You cannot view this document.');
    }

    try {
      const contents = await this.storage.read(documentStorageKey(document.fileUrl));

      await trackOptionalActivity(this.activityTracking, {
        organizationId,
        userId,
        eventName: 'DOCUMENT_VIEWED',
        entityType: 'Document',
        entityId: id,
        metadata: {
          mimeType: document.mimeType,
        },
        userAgent,
      });

      return {
        fileName: document.fileName,
        mimeType: document.mimeType || 'application/octet-stream',
        contents,
      };
    } catch (error) {
      if (!(error instanceof DocumentStorageNotFoundError)) throw error;
      this.logger.warn(
        `Uploaded file missing organizationId=${organizationId} documentId=${id} storageKey=${document.fileUrl}`,
      );
      throw new NotFoundException(
        'Uploaded file is no longer available on the server.',
      );
    }

  }

  async remove(organizationId: string, id: string, userId?: string) {
    const document = await this.prisma.document.findUnique({
      where: { id },
      select: { fileUrl: true },
    });
    if (document && isVirtualSpreadsheetSourceUrl(document.fileUrl)) {
      const outcome = await this.recovery.deleteVirtualDocument(
        organizationId,
        id,
        userId,
      );
      if (!outcome) throw new NotFoundException(`Document ${id} not found.`);
      return {
        deletedDocument: true,
        deletedActivityRecords: 0,
        preservedActivityRecords: outcome.preservedActivityRecords,
        sourceEvidence: 'NONE' as const,
        storageLifecycle: 'NOT_APPLICABLE' as const,
        idempotent: false,
      };
    }

    const intent = await this.recovery.prepareDocument(organizationId, id, userId);
    if (!intent) throw new NotFoundException(`Document ${id} not found.`);
    const outcome = await this.recovery.completeDocument(organizationId, id, userId);
    if (!outcome) throw new NotFoundException(`Document ${id} not found.`);
    return {
      deletedDocument: true,
      deletedActivityRecords: 0,
      preservedActivityRecords: outcome.preservedActivityRecords,
      sourceEvidence: 'QUARANTINED' as const,
      deletionIntentId: outcome.intent.id,
      storageLifecycle: outcome.intent.status,
      idempotent: outcome.idempotent,
    };
  }

  private get recovery() {
    if (!this.deletionRecovery) {
      throw new ServiceUnavailableException('Recoverable deletion enforcement is unavailable.');
    }
    return this.deletionRecovery;
  }

  private get quotaEnforcement() {
    if (!this.quotas) {
      throw new ServiceUnavailableException('Organization quota enforcement is unavailable.');
    }
    return this.quotas;
  }

}

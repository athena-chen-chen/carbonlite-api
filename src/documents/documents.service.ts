import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { access } from 'fs/promises';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ActivityTrackingService } from '../activity-tracking/activity-tracking.service';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly activityTracking: ActivityTrackingService,
  ) {}

  async upload(
    organizationId: string,
    userId: string,
    file: Express.Multer.File,
    type?: string,
  ) {
    const created = await this.prisma.document.create({
      data: {
        organizationId,
        uploadedById: userId,
        fileName: file.originalname,
        fileUrl: `/uploads/${file.filename}`,
        mimeType: file.mimetype,
        fileSize: file.size,
        type: (type as any) ?? 'OTHER',
        status: 'UPLOADED',
      },
    });

    await this.auditLog.log({
      organizationId,
      userId,
      action: 'UPLOAD_DOCUMENT',
      entityType: 'Document',
      entityId: created.id,
      description: `Uploaded document ${created.fileName}`,
      newValue: created,
    });

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'DOCUMENT_UPLOADED',
      entityType: 'Document',
      entityId: created.id,
      metadata: {
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
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.document.count({ where }),
    ]);

    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
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

    const relativePath = document.fileUrl.replace(/^\/+/, '');
    const absolutePath = join(process.cwd(), relativePath);

    try {
      await access(absolutePath);
    } catch {
      throw new NotFoundException(
        'Uploaded file is no longer available on the server.',
      );
    }

    await this.activityTracking.track({
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
      absolutePath,
    };
  }

  async remove(organizationId: string, id: string, userId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const document = await tx.document.findUnique({
        where: { id },
      });

      if (!document) {
        throw new NotFoundException(`Document ${id} not found.`);
      }

      if (document.organizationId !== organizationId) {
        throw new ForbiddenException('You cannot delete this document.');
      }

      const relatedActivities = await tx.activityData.findMany({
        where: {
          organizationId,
          sourceDocumentId: id,
        },
        select: { id: true },
      });
      const relatedActivityIds = relatedActivities.map((item) => item.id);

      if (relatedActivityIds.length > 0) {
        await tx.metricResult.deleteMany({
          where: {
            organizationId,
            activityDataId: { in: relatedActivityIds },
          },
        });
      }

      const deletedActivityRecords = await tx.activityData.deleteMany({
        where: {
          organizationId,
          sourceDocumentId: id,
        },
      });

      await tx.document.delete({
        where: { id },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          userId: userId ?? null,
          action: 'DELETE_DOCUMENT',
          entityType: 'Document',
          entityId: id,
          description: `Deleted document ${document.fileName}`,
          oldValue: JSON.parse(
            JSON.stringify({
              document,
              deletedActivityRecords: deletedActivityRecords.count,
            }),
          ),
        },
      });

      await tx.userActivityEvent.create({
        data: {
          organizationId,
          userId: userId ?? null,
          eventName: 'DOCUMENT_DELETED',
          entityType: 'Document',
          entityId: id,
          metadata: {
            deletedActivityRecords: deletedActivityRecords.count,
          },
        },
      });

      return {
        deletedDocument: true,
        deletedActivityRecords: deletedActivityRecords.count,
      };
    });
  }
}
